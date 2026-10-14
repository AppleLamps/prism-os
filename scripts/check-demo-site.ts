// Loads the built demo site in headless Chrome, served the way GitHub Pages serves a project's site: static files
// under a path prefix. A page that only works at a host's root, e.g. because of a URL like "/os/", fails here.
//   bun run site:check                                   builds the site first, then checks site/
//   bun scripts/check-demo-site.ts --no-build            checks site/ as it is
//   bun scripts/check-demo-site.ts --port 5000 --debugging-port 9333 --screenshots <folder>
// For each page of demo-site-pages.ts, the check fails when the page logs an error or a warning, throws, requests a
// file that fails to load, or requests anything outside the site, and when a link on the page to another page of the
// site doesn't resolve. It also waits for what each demo shows once its program has run, and prints it, e.g.
// HandwiredOS's Monitor window with the program's sizes. The index's cards round those sizes, e.g. "about 4,300
// operations", and the check fails when a rounded number is more than 10% away from what the demo's page reports.
// The server listens on a free port unless --port names one, and Chrome picks its debugging port unless
// --debugging-port names one. CHROME_PATH overrides the Chrome binary, and CHROME_PROFILE_DIR the profile folder,
// which defaults to a new folder in the system's temporary folder. --screenshots saves a PNG of each page.
// The script stops Chrome and the server when it finishes, and after 3 minutes at most.
import {existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {repoRoot, sitePages} from './demo-site-pages.ts'

const siteFolder = path.join(repoRoot, 'site')
// GitHub Pages serves a project's site under the repo's name.
const prefix = '/handwired/'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

// What each demo shows once its program has run: `ready` is polled until it is true, and `report` is printed.
// Both are JavaScript evaluated in the page. A page without an entry is loaded and given a moment. The reports
// include each page's own counts, e.g. HandwiredOS's operations and layers, which is where the rounded numbers on the
// index's cards come from.
const textOf = (selector: string) => `[...document.querySelectorAll('${selector}')].map(element => element.textContent.trim().replace(/\\s+/g, ' ')).filter(text => text !== '').join('\\n')`
const expectations: Record<string, {ready: string, report: string}> = {
  'os/': {
    // HandwiredOS reports its program in its Monitor window, which the page fills from the compiled program at
    // mount. Each item of the window's sidebar counts a location's rows, and a pointer that rests on the item reads
    // the count with what a row is, e.g. "4,254 operations. What the program computes: ...". The window's footer
    // counts the rest, e.g. "123 layers", "8,965 weights". The report is the sidebar's counts, then the footer's.
    ready: `/\\d/.test(document.querySelector('.monitor-counts')?.textContent ?? '')`,
    report: `[
      ...[...document.querySelectorAll('.monitor-location')].map(item => item.title.split('.')[0]),
      ...[...document.querySelectorAll('.monitor-counts li')].map(item => item.textContent.trim()),
    ].join(', ')`,
  },
  'learned-gallery/': {
    ready: `/\\d/.test(document.querySelector('#learning-coefficients')?.textContent ?? '')`,
    report: `document.querySelector('#learning-coefficients').textContent.trim() + ' trained weights'`,
  },
  'json-search/': {
    // The page is ready once its documents are loaded and its line of numbers holds the first search's, e.g.
    // "10,559 of 100,000 documents match. This program: 13 ms on the GPU." In a browser without WebGPU the search runs on the CPU
    // and takes 20 s or more, so there the first numbers are a part of the answer, e.g. "56 of the first 596
    // documents match.", and the page also shows a sentence that says why. The report is that line, then the
    // programs that the page compiled for the GPU with the size of each one's shader, e.g. "regex search, 8 states:
    // 147 statements", which is the shader as src/json-search/bit-emit.ts writes it.
    ready: `window.jsonSearch?.ready === true && / documents match/.test(document.querySelector('#status')?.textContent ?? '')`,
    report: `${textOf('#status, #notice')} + '\\n' + (window.jsonSearch.programs === null ? 'Both programs run on the CPU.' : window.jsonSearch.programs.map(program => program.name + ': ' + program.statements + ' statements').join(', '))`,
  },
}

if (!process.argv.includes('--no-build')) {
  const build = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'build-demo-site.ts')], {cwd: repoRoot, stdout: 'inherit', stderr: 'inherit'})
  if (build.exitCode !== 0) process.exit(build.exitCode)
}
if (!existsSync(path.join(siteFolder, 'index.html'))) {
  console.error(`${siteFolder} has no index.html. Run \`bun run site:build\` first, or leave out --no-build.`)
  process.exit(1)
}

// The static server. Like GitHub Pages, a folder's URL serves its index.html, and a folder's URL without the "/" at
// its end redirects to the URL with it.
const requests: {path: string, status: number}[] = []
const server = Bun.serve({
  port: Number(option('port') ?? 0),
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    const respond = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => {
      requests.push({path: url.pathname, status})
      return new Response(body, {status, headers})
    }
    if (`${url.pathname}/` === prefix) return respond(301, null, {location: prefix})
    if (!url.pathname.startsWith(prefix)) return respond(404, 'Not found: outside the site')
    const file = path.join(siteFolder, decodeURIComponent(url.pathname.slice(prefix.length)))
    if (file !== siteFolder && !file.startsWith(siteFolder + path.sep)) return respond(404, 'Not found')
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) return respond(301, null, {location: `${url.pathname}/${url.search}`})
      const index = path.join(file, 'index.html')
      return existsSync(index) ? respond(200, Bun.file(index)) : respond(404, 'Not found')
    }
    return existsSync(file) ? respond(200, Bun.file(file)) : respond(404, 'Not found')
  },
})
const origin = `http://127.0.0.1:${server.port}`
const siteUrl = `${origin}${prefix}`

const chromePath = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(chromePath)) {
  console.error(`Chrome isn't at ${chromePath}. Set CHROME_PATH to a Chrome or Chromium binary.`)
  void server.stop(true)
  process.exit(1)
}
const profile = process.env['CHROME_PROFILE_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'handwired-site-check-chrome-'))
const screenshots = option('screenshots')
const debuggingPort = option('debugging-port')
// A browser that already listens on the named debugging port would be driven instead of the Chrome started below.
if (debuggingPort !== undefined && await fetch(`http://127.0.0.1:${debuggingPort}/json/version`).then(() => true, () => false)) {
  console.error(`A browser already listens on debugging port ${debuggingPort}. Name another port, or leave --debugging-port out.`)
  void server.stop(true)
  process.exit(1)
}
// --enable-unsafe-webgpu gives headless Chrome WebGPU, which the GPU search demo needs once it is on the site.
const chrome = Bun.spawn([chromePath, '--headless=new', `--remote-debugging-port=${debuggingPort ?? '0'}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--enable-unsafe-webgpu', '--window-size=1440,900', 'about:blank'], {stdout: 'ignore', stderr: 'ignore'})
const finish = (code: number) => {
  chrome.kill('SIGKILL')
  void server.stop(true)
  process.exit(code)
}
setTimeout(() => {
  console.error('timed out after 3 minutes')
  finish(1)
}, 180_000)

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Chrome writes the debugging port it listens on into the profile folder, as the file's first line.
function readDevToolsPort(portFile: string): string | undefined {
  if (!existsSync(portFile)) return undefined
  const firstLine = readFileSync(portFile, 'utf8').split('\n')[0] ?? ''
  return firstLine === '' ? undefined : firstLine
}

type ProtocolEvent = {method: string, params: {
  type?: string
  args?: {value?: unknown, description?: string}[]
  exceptionDetails?: {text: string, exception?: {description?: string}}
  entry?: {level: string, text: string, url?: string}
  requestId?: string
  request?: {url: string}
  response?: {url: string, status: number}
  errorText?: string
  canceled?: boolean
}}

// A console argument as text: a string as it is, another value as JSON, and an object by Chrome's description of it.
function consoleArgumentText(argument: {value?: unknown, description?: string}): string {
  if (typeof argument.value === 'string') return argument.value
  return argument.value !== undefined ? JSON.stringify(argument.value) : argument.description ?? ''
}

let failed = false
try {
  const port = debuggingPort ?? await waitFor(() => readDevToolsPort(path.join(profile, 'DevToolsActivePort')), 'DevToolsActivePort')
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json() as Promise<{type: string, webSocketDebuggerUrl: string}[]>).catch(() => [])
    return list.find(candidate => candidate.type === 'page')
  }, 'a page target')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}))
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  // What the page under check has done wrong so far, and the URL of each of its requests by the request's id.
  let pageProblems: string[] = []
  let requestUrls = new Map<string, string>()
  let loadEventFired = false
  socket.addEventListener('message', message => {
    const data = JSON.parse(String(message.data)) as {id?: number, result?: unknown, error?: {message: string}} & Partial<ProtocolEvent>
    if (data.id !== undefined) {
      if (data.error !== undefined) console.error('DevTools Protocol error', data.error.message)
      pending.get(data.id)?.(data.result)
      pending.delete(data.id)
      return
    }
    const params = data.params
    if (params === undefined) return
    if (data.method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning' || params.type === 'assert')) {
      pageProblems.push(`console.${params.type}: ${(params.args ?? []).map(consoleArgumentText).join(' ')}`)
    } else if (data.method === 'Runtime.exceptionThrown' && params.exceptionDetails !== undefined) {
      pageProblems.push(`uncaught exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`)
    } else if (data.method === 'Log.entryAdded' && params.entry !== undefined && (params.entry.level === 'error' || params.entry.level === 'warning')) {
      // The network events below already report a file that failed to load.
      if (!params.entry.text.startsWith('Failed to load resource')) pageProblems.push(`browser ${params.entry.level}: ${params.entry.text} ${params.entry.url ?? ''}`.trim())
    } else if (data.method === 'Network.requestWillBeSent' && params.requestId !== undefined && params.request !== undefined) {
      const url = params.request.url
      requestUrls.set(params.requestId, url)
      if (!url.startsWith(siteUrl) && !/^(data|blob|about):/.test(url)) pageProblems.push(`a request outside the site: ${url}`)
    } else if (data.method === 'Network.responseReceived' && params.response !== undefined && params.response.status >= 400) {
      pageProblems.push(`${params.response.status} for ${params.response.url}`)
    } else if (data.method === 'Network.loadingFailed' && params.requestId !== undefined && params.canceled !== true) {
      pageProblems.push(`a request failed (${params.errorText ?? 'no reason given'}): ${requestUrls.get(params.requestId) ?? 'unknown URL'}`)
    } else if (data.method === 'Page.loadEventFired') {
      loadEventFired = true
    }
  })
  const send = <Result>(method: string, params: object = {}) => new Promise<Result>(resolve => {
    const id = nextId++
    pending.set(id, result => resolve(result as Result))
    socket.send(JSON.stringify({id, method, params}))
  })
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await send<{result: {value: T}}>('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result.value

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false})
  const version = await send<{product: string}>('Browser.getVersion')
  console.log(`\nChecking ${siteUrl} in ${version.product}`)

  // Every page a link points to is requested once, however many pages link to it.
  const linkStatus = new Map<string, number>()
  // The rounded counts on the index's cards, each in an element with data-count inside the card's link, e.g.
  // <span data-count="operations">4,300</span> in the link to os/. And each page's printed report.
  let indexCounts: {path: string, name: string, value: number}[] = []
  const reports = new Map<string, string>()
  for (const page of sitePages) {
    pageProblems = []
    requestUrls = new Map()
    loadEventFired = false
    const pageUrl = `${siteUrl}${page.path}`
    await send('Page.navigate', {url: pageUrl})
    await waitFor(() => loadEventFired ? true : undefined, `the load event of ${pageUrl}`, 30_000)
    const expectation = expectations[page.path]
    let report = ''
    if (expectation !== undefined) {
      try {
        await waitFor(async () => (await evaluate<boolean>(expectation.ready)) ? true : undefined, expectation.ready, 30_000)
        report = await evaluate<string>(expectation.report)
      } catch (error) {
        pageProblems.push(`the page never showed what its program computes: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Time for a request or an error that follows the first frames, e.g. a lazy image or a late exception.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    await Bun.sleep(300)

    reports.set(page.path, report)
    if (page.path === '') {
      indexCounts = await evaluate<typeof indexCounts>(`[...document.querySelectorAll('a[href] [data-count]')].filter(element => element.checkVisibility()).map(element => ({
        path: element.closest('a').href.slice(${JSON.stringify(siteUrl)}.length), name: element.dataset.count, value: Number(element.textContent.replaceAll(',', '')),
      }))`)
    }
    const title = await evaluate<string>('document.title')
    if (title.trim() === '') pageProblems.push('the page has no title')
    const links = await evaluate<{href: string, visible: boolean}[]>(`[...document.querySelectorAll('a[href]')].map(link => ({href: link.href, visible: link.checkVisibility()}))`)
    let linksToThePage = 0
    let linksElsewhere = 0
    for (const link of links) {
      if (!link.href.startsWith(origin)) {
        linksElsewhere++
        continue
      }
      // A link that isn't shown is the switch of a demo that isn't published yet, e.g. the GPU search's card.
      if (!link.visible) continue
      linksToThePage++
      const linked = link.href.split('#', 1)[0]!
      if (!linked.startsWith(siteUrl)) {
        pageProblems.push(`a link leaves the site: ${link.href}`)
        continue
      }
      let status = linkStatus.get(linked)
      if (status === undefined) {
        const response = await fetch(linked, {redirect: 'manual'})
        status = response.status
        linkStatus.set(linked, status)
      }
      if (status !== 200) pageProblems.push(`a link gets ${status}: ${link.href}`)
    }

    if (screenshots !== undefined) {
      mkdirSync(screenshots, {recursive: true})
      const shot = await send<{data: string}>('Page.captureScreenshot', {format: 'png'})
      writeFileSync(path.join(screenshots, `${page.path === '' ? 'index' : page.path.slice(0, -1)}.png`), Buffer.from(shot.data, 'base64'))
    }

    const requestCount = [...requestUrls.values()].filter(url => url.startsWith(siteUrl)).length
    console.log(`\n${pageProblems.length === 0 ? 'ok  ' : 'FAIL'} ${prefix}${page.path}  "${title}"  ${requestCount} requests, ${linksToThePage} links into the site, ${linksElsewhere} to other hosts`)
    for (const line of report.split('\n')) if (line !== '') console.log(`      ${line}`)
    for (const problem of pageProblems) console.log(`      problem: ${problem}`)
    if (pageProblems.length > 0) failed = true
  }

  // A count on the index against the first "<number> <name>" of the demo's report, e.g. "4,254 operations". One
  // word may stand between the two, e.g. "244 trained weights".
  if (indexCounts.length > 0) console.log(`\nThe index's rounded counts, each within 10% of what the demo's page reports:`)
  for (const count of indexCounts) {
    const found = new RegExp(`(\\d[\\d,]*) +(?:\\w+ +)?${count.name}\\b`).exec(reports.get(count.path) ?? '')
    const onTheIndex = `${prefix}${count.path} ${count.name}: ${count.value.toLocaleString('en-US')} on the index`
    if (found === null) {
      console.log(`      not compared, since the page's report above has no count of ${count.name}: ${onTheIndex}`)
      continue
    }
    const reported = Number(found[1]!.replaceAll(',', ''))
    if (Math.abs(count.value - reported) <= 0.1 * reported) {
      console.log(`ok    ${onTheIndex}, ${reported.toLocaleString('en-US')} on the page`)
    } else {
      failed = true
      console.log(`FAIL  ${onTheIndex}, ${reported.toLocaleString('en-US')} on the page. Write ${Number(reported.toPrecision(2)).toLocaleString('en-US')} in the card's element with data-count="${count.name}" in assets/demos.html.`)
    }
  }

  const outside = requests.filter(request => !request.path.startsWith(prefix) && `${request.path}/` !== prefix)
  if (outside.length > 0) {
    failed = true
    console.log(`\nFAIL requests outside ${prefix}: ${[...new Set(outside.map(request => request.path))].join(', ')}`)
  }
  console.log(failed ? '\nThe site has problems.' : `\nThe site's ${sitePages.length} pages load under ${prefix} without a problem.`)
  socket.close()
  finish(failed ? 1 : 0)
} catch (error) {
  console.error(error)
  finish(1)
}
