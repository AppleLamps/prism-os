// Builds the demo site into site/, the folder that GitHub Pages and Vercel publish: Prism OS at site/index.html, the
// list of demos at site/demos/index.html and each other demo in its own folder, e.g. site/os/index.html, as listed in
// demo-site-pages.ts.
//   bun run site:build
// The steps:
// 1. Empty site/. The folder holds nothing but this script's output, and .gitignore lists it.
// 2. Run `bun build` on every page at once, so the pages share the chunks that several of them import, e.g. the
//    runtime. Bun writes the scripts, stylesheets and large images under hashed names at the top of site/, and each
//    page's HTML at its path in the repo, e.g. site/assets/index.html.
// 3. Move each page's HTML to its folder on the site. The URLs in its <link>, <script> and <img> tags are relative
//    to the HTML file, so they are rewritten for the new folder. Links between pages stay as written, since the
//    pages write them for the site's layout already, e.g. "../learned-gallery/". Every page gets the site's icon.
// 4. Build each script that a page starts as a worker, as one file next to its page, e.g. site/json-search/demo-worker.js.
// 5. Check the result, and fail when a page is missing, when a page loads a file or links to a page that isn't in
//    site/, when a page loads anything from another host, or when a URL starts with "/". The site is served under
//    a path prefix, e.g. https://example.com/handwired/, where a URL like "/os/" leaves the site. The check reads
//    the HTML and CSS files, and the CSS inside the HTML, e.g. a style attribute. scripts/check-demo-site.ts loads
//    the pages in a browser, which also covers what the scripts request while they run.
import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readdir, readFile, rm, rmdir, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {demosPath, iconLinkTag, repoRoot, siteFoldersNotBuilt, sitePages, siteWorkers} from './demo-site-pages.ts'

const outdir = path.join(repoRoot, 'site')
const problems: string[] = []
const pagesWithSeveralStylesheets: string[] = []
const pagesWithTheirOwnIcon: string[] = []

// The tags whose URL names a file that the page loads. Bun points these URLs at the files it wrote.
const loadingTags = /<(?:link|script|img)\b[^>]*>/g
const urlAttribute = /\b(src|href)="([^"]*)"/
const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url)
const isRelative = (url: string) => url !== '' && !hasScheme(url) && !url.startsWith('/') && !url.startsWith('#')
const withoutQuery = (url: string) => url.split(/[?#]/, 1)[0]!

function urlFromFolder(folder: string, file: string): string {
  const relative = path.relative(folder, file).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

// Bun inlines an image under 128 KiB into a stylesheet that names it, and then leaves an <img> tag that names the
// same image pointing at the source file, which site/ doesn't have, e.g. the index's four photos, which
// HandwiredOS's stylesheet also names. Such an image is copied here, under a name with a hash of its bytes, as Bun
// names the images it writes.
async function copyImageThatBunLeft(sourceFile: string): Promise<string> {
  const bytes = await readFile(sourceFile)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const {name, ext} = path.parse(sourceFile)
  const copy = path.join(outdir, `${name}-${hash}${ext}`)
  await writeFile(copy, bytes)
  return copy
}

async function movePage(source: string, sitePath: string) {
  const builtFile = path.join(outdir, source)
  const targetFile = path.join(outdir, sitePath, 'index.html')
  if (!existsSync(builtFile)) {
    problems.push(`${source}: bun build wrote no ${path.relative(repoRoot, builtFile)}`)
    return
  }
  let html = await readFile(builtFile, 'utf8')

  // Bun gives a page without a script an empty script. Its tag is removed here, and the empty file after the pages.
  for (const [element] of html.matchAll(/<script\b[^>]*><\/script>/g)) {
    const url = urlAttribute.exec(element)?.[2]
    if (url === undefined || !isRelative(url)) continue
    const file = path.resolve(path.dirname(builtFile), withoutQuery(url))
    if (existsSync(file) && (await stat(file)).size === 0) html = html.replace(element, '')
  }

  const rewrittenTags = new Map<string, string>()
  for (const [tag] of html.matchAll(loadingTags)) {
    const attribute = urlAttribute.exec(tag)
    if (attribute === null || !isRelative(attribute[2]!)) continue
    const url = attribute[2]!
    let file = path.resolve(path.dirname(builtFile), withoutQuery(url))
    if (!existsSync(file)) {
      const sourceFile = path.resolve(repoRoot, path.dirname(source), withoutQuery(url))
      if (!existsSync(sourceFile)) {
        problems.push(`${source}: ${tag} names a file that doesn't exist`)
        continue
      }
      file = await copyImageThatBunLeft(sourceFile)
    }
    const rewrittenUrl = urlFromFolder(path.dirname(targetFile), file) + url.slice(withoutQuery(url).length)
    rewrittenTags.set(tag, tag.replace(attribute[0], `${attribute[1]}="${rewrittenUrl}"`))
  }
  for (const [tag, rewritten] of rewrittenTags) html = html.replaceAll(tag, rewritten)

  // Without an icon, a page would request /favicon.ico from the host's root, outside the site. A page that names an
  // icon itself keeps it.
  if (/<link\b[^>]*\brel="icon"/.test(html)) pagesWithTheirOwnIcon.push(source)
  else html = html.replace('</head>', `${iconLinkTag}\n</head>`)

  await mkdir(path.dirname(targetFile), {recursive: true})
  await writeFile(targetFile, html)
  if (builtFile !== targetFile) await rm(builtFile)
  // The folders Bun made for the page's path in the repo, once empty, e.g. site/assets after its last page.
  for (let folder = path.dirname(builtFile); folder !== outdir && (await readdir(folder)).length === 0; folder = path.dirname(folder)) {
    await rmdir(folder)
  }

  // Bun joins a page's stylesheets into one file, so the page's own links are counted in its source.
  const sourceHtml = (await readFile(path.join(repoRoot, source), 'utf8')).replace(/<!--[\s\S]*?-->/g, '')
  const stylesheetCount = [...sourceHtml.matchAll(loadingTags)].filter(([tag]) => /\brel="stylesheet"/.test(tag)).length
  if (stylesheetCount > 1) pagesWithSeveralStylesheets.push(`${source} (${stylesheetCount})`)
}

// Every URL of a built HTML or CSS file, with the text around it for the report.
type FoundUrl = {url: string, where: string, loadsAFile: boolean, hidden: boolean}
function urlsOfCss(css: string): FoundUrl[] {
  const urls: FoundUrl[] = []
  // An inline image can hold a url() of its own, e.g. url(%23g) inside an inline SVG, so inline images go first.
  const withoutInlineImages = css.replace(/url\(\s*(?:"data:[^"]*"|'data:[^']*'|data:[^)]*)\s*\)/g, '')
  for (const [whole, url] of withoutInlineImages.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) urls.push({url: url!, where: whole, loadsAFile: true, hidden: false})
  for (const [whole, url] of withoutInlineImages.matchAll(/@import\s*["']([^"']+)["']/g)) urls.push({url: url!, where: whole, loadsAFile: true, hidden: false})
  return urls
}
function urlsOf(name: string, text: string): FoundUrl[] {
  if (!name.endsWith('.html')) return urlsOfCss(text)
  const urls: FoundUrl[] = []
  const html = text.replace(/<!--[\s\S]*?-->/g, '')
  for (const [tag, tagName] of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    for (const [, url] of tag.matchAll(/\b(?:src|href|action|poster)="([^"]*)"/g)) {
      urls.push({url: url!, where: tag, loadsAFile: tagName!.toLowerCase() !== 'a', hidden: /\shidden(?=[\s>=])/.test(tag)})
    }
    // The CSS that a tag carries, e.g. style="background: url(/photo.webp)".
    for (const [, css] of tag.matchAll(/\sstyle="([^"]*)"/g)) urls.push(...urlsOfCss(css!))
  }
  // The CSS that the page carries in <style> elements, which Bun leaves as written.
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) urls.push(...urlsOfCss(css!))
  return urls
}

async function checkSite(): Promise<{fileCount: number, byteCount: number}> {
  const names: string[] = []
  let byteCount = 0
  for (const name of await readdir(outdir, {recursive: true})) {
    const fileStat = await stat(path.join(outdir, name))
    if (!fileStat.isFile()) continue
    names.push(name.split(path.sep).join('/'))
    byteCount += fileStat.size
  }
  const pageFiles = sitePages.map(page => `${page.path}index.html`)
  for (const [index, page] of sitePages.entries()) {
    if (!names.includes(pageFiles[index]!)) problems.push(`${page.source}: site/${pageFiles[index]!} is missing`)
  }
  for (const name of names) {
    if (name.endsWith('.html') && !pageFiles.includes(name)) problems.push(`site/${name} is an HTML file that isn't a page of the site`)
    if (!name.endsWith('.html') && !name.endsWith('.css')) continue
    for (const {url, where, loadsAFile, hidden} of urlsOf(name, await readFile(path.join(outdir, name), 'utf8'))) {
      if (url.startsWith('/')) {
        problems.push(`site/${name}: ${where} has a URL that starts at the host's root. Under a path prefix that URL leaves the site, so write it relative to the page, e.g. "../demos/" for the list of demos.`)
      } else if (hasScheme(url)) {
        if (loadsAFile && !url.startsWith('data:')) problems.push(`site/${name}: ${where} loads a file from another host`)
      } else if (isRelative(url)) {
        const target = path.posix.join(path.posix.dirname(name), withoutQuery(url))
        if (target.startsWith('..')) {
          problems.push(`site/${name}: ${where} points outside the site`)
          continue
        }
        const targetFile = withoutQuery(url).endsWith('/') || target === '.' ? path.posix.join(target, 'index.html') : target
        if (names.includes(targetFile)) continue
        const folderNotBuilt = siteFoldersNotBuilt.find(folder => targetFile === `${folder}index.html`)
        if (folderNotBuilt !== undefined) {
          // A link with the hidden attribute is the switch of a demo whose page doesn't exist yet.
          if (!hidden) problems.push(`site/${name}: ${where} links to a demo whose page doesn't exist. Keep the hidden attribute on the link until the page exists.`)
        } else if (pageFiles.includes(`${target}/index.html`)) {
          problems.push(`site/${name}: ${where} links to a page's folder without the "/" at its end, which costs a redirect. Write "${url}/".`)
        } else {
          problems.push(`site/${name}: ${where} names ${targetFile}, which isn't in site/`)
        }
      }
    }
  }
  // A page that the list of demos doesn't link to can only be reached by its address, e.g. a demo whose card is still
  // hidden. Each link is resolved from the list's folder to a path from the site's root, e.g. "../os/" to "os/".
  const demosFile = `${demosPath}index.html`
  const demosHtml = names.includes(demosFile) ? await readFile(path.join(outdir, demosFile), 'utf8') : ''
  const linkedFromTheList = urlsOf(demosFile, demosHtml).filter(found => !found.hidden).filter(found => isRelative(found.url))
    .map(found => path.posix.join(demosPath, withoutQuery(found.url)))
    .map(target => target === './' || target === '.' ? '' : target)
  for (const page of sitePages) {
    if (page.path !== demosPath && !linkedFromTheList.includes(page.path)) console.warn(`Note: site/${page.path} is built from ${page.source}, and the list of demos has no visible link to it.`)
  }
  return {fileCount: names.length, byteCount}
}

await rm(outdir, {recursive: true, force: true})

const build = Bun.spawnSync(
  [process.execPath, 'build', ...sitePages.map(page => page.source), '--root', '.', '--outdir', outdir, '--minify', '--splitting'],
  {cwd: repoRoot, stdout: 'inherit', stderr: 'inherit'},
)
if (build.exitCode !== 0) process.exit(build.exitCode)

for (const page of sitePages) await movePage(page.source, page.path)
for (const worker of siteWorkers) {
  const built = await Bun.build({entrypoints: [path.join(repoRoot, worker.source)], target: 'browser', format: 'iife', minify: true, throw: false})
  const script = built.outputs[0]
  if (!built.success || script === undefined) problems.push(`${worker.source}: ${built.logs.map(log => log.message).join('; ')}`)
  else await Bun.write(path.join(outdir, worker.path), script)
}
// The empty scripts of the pages without a script, and the empty chunks Bun splits off them. Bun 1.3 also writes empty
// chunks that other scripts import, e.g. `import"./prism-os-g71vysdg.js"`, and a page whose script imports a missing
// file runs none of it, so an empty chunk that a script names stays.
const builtScripts = (await readdir(outdir)).filter(name => name.endsWith('.js'))
const builtCode = (await Promise.all(builtScripts.map(name => readFile(path.join(outdir, name), 'utf8')))).join('\n')
for (const name of builtScripts) {
  if ((await stat(path.join(outdir, name))).size === 0 && !builtCode.includes(`/${name}`)) await rm(path.join(outdir, name))
}
const {fileCount, byteCount} = await checkSite()
if (pagesWithTheirOwnIcon.length > 0) {
  console.warn(`Note: these pages have an icon link of their own and keep it, so they don't get the site's icon from scripts/demo-site-pages.ts: ${pagesWithTheirOwnIcon.join(', ')}.`)
}
if (pagesWithSeveralStylesheets.length > 0) {
  console.warn(`Note: these pages link more than one stylesheet: ${pagesWithSeveralStylesheets.join(', ')}. Bun's development server writes several stylesheet links in the reverse of the page's order (seen in Bun 1.4.3), and this build keeps the page's order. So a rule that overrides a rule of an earlier stylesheet at the same specificity applies in the built site and loses while developing. A page that links one stylesheet, which starts with an @import of the others, looks the same in both.`)
}

if (problems.length > 0) {
  console.error(`\nThe site in ${outdir} has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log(`\nBuilt ${sitePages.length} pages into ${outdir}: ${fileCount} files, ${Math.round(byteCount / 1024).toLocaleString('en-US')} KiB.`)
  for (const page of sitePages) console.log(`  ${`/${page.path}`.padEnd(20)} ${page.source}`)
  if (siteFoldersNotBuilt.length > 0) console.log(`  Not built, since the page doesn't exist yet: ${siteFoldersNotBuilt.map(folder => `/${folder}`).join(', ')}`)
}
