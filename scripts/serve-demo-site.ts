// Serves the demo site while developing, at the paths of the published site: the index at /, HandwiredOS at /os/,
// and so on, as listed in demo-site-pages.ts. The links between pages are relative and written for those paths, so
// the same links work here and in the built site.
//
//   bun start                                       (http://127.0.0.1:3000/)
//   bun scripts/serve-demo-site.ts --port 5000      (or PORT=5000)
//   bun scripts/serve-demo-site.ts --host 0.0.0.0   (or HOST; the default is 127.0.0.1)
//
// Each page is a Bun HTML import, as with `bun ./assets/index.html`: Bun bundles a page the first time it's requested
// and reloads open pages when their files change. A page's path without the "/" at its end, e.g. /os, redirects to
// /os/, as GitHub Pages does, so a page's relative links resolve the same way however the page was reached.
import {resolve} from 'node:path'
import {iconSvg, repoRoot, sitePages} from './demo-site-pages.ts'

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

const routes: Record<string, Bun.HTMLBundle | Response> = {
  // The built pages carry the icon inline. Here the browser's request for /favicon.ico gets the same image.
  '/favicon.ico': new Response(iconSvg, {headers: {'content-type': 'image/svg+xml'}}),
}
for (const page of sitePages) {
  // The list of pages decides which files are imported, so the import's path is computed.
  const module = await import(resolve(repoRoot, page.source)) as {default: Bun.HTMLBundle}
  routes[`/${page.path}`] = module.default
  if (page.path !== '') routes[`/${page.path.slice(0, -1)}`] = new Response(null, {status: 302, headers: {location: `/${page.path}`}})
}

const portText = option('port') ?? process.env['PORT'] ?? '3000'
const port = Number(portText)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`The port must be an integer from 0 to 65535, got "${portText}".`)
  process.exit(1)
}
// 127.0.0.1 rather than localhost: localhost resolves to IPv6 ::1 first, and while one server holds [::1]:3000, a
// second server can start on 127.0.0.1:3000 without an error, and a browser may reach either.
const hostname = option('host') ?? process.env['HOST'] ?? '127.0.0.1'

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    port,
    hostname,
    // Development mode bundles each page on its first request and reloads open pages when their files change.
    development: true,
    routes,
    fetch: () => new Response('Not found', {status: 404}),
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Couldn't start the server on ${hostname}:${port} (${message}). Pick another port with --port <number> or PORT=<number>.`)
  process.exit(1)
}

console.log(`Handwired demo site: ${server.url}`)
for (const page of sitePages) {
  if (page.path !== '') console.log(`  ${new URL(page.path, server.url).href}  ${page.source}`)
}
