// The JS reference: chenglou.github.io's frozen index.ts (lab/trace-compiler/fixtures/index.ts.txt,
// gallery commit f315d586), executed natively by the JS engine against a FakeBrowser.
// Only the TypeScript types are erased and the `import {photoGalleryData} from './data'` line is
// replaced by a parameter. Everything else, including the render function, the spring loop, the
// hit tests and the DOM writes, is the original source running unchanged.
import {readFileSync} from 'node:fs'
import {createFixtureGlobals, FakeBrowser, FakeNode} from './fake-dom.ts'
import type {PhotoData} from './photo-data.ts'

const fixtureDirectory = new URL('../../../../trace-compiler/fixtures/', import.meta.url)

export type ReferenceSpring = {pos: number, dest: number, v: number, k: number, b: number}

export type ReferenceBox = {
  id: string
  naturalSizeX: number
  ar: number
  sizeX: ReferenceSpring
  sizeY: ReferenceSpring
  x: ReferenceSpring
  y: ReferenceSpring
  scale: ReferenceSpring
  fxFactor: ReferenceSpring
  node: FakeNode
  img: FakeNode
  promptNode: FakeNode
}

export type ReferenceState = {
  anchor: number
  windowSizeX: number
  scrollY: number
  animatedUntilTime: number | null
  pointerX: number
  pointerY: number
}

type FixtureModule = {
  render(now: number): boolean
  data: ReferenceBox[]
  state(): ReferenceState
  colsBoxMaxSizeXF(containerSizeX: number): {cols: number, boxMaxSizeX: number}
}

let cachedIndexCode: string | null = null
let cachedPhotos: PhotoData[] | null = null

function transpile(source: string) {
  return new Bun.Transpiler({loader: 'ts'}).transformSync(source)
}

// The fixture's photo array, evaluated from data.ts.txt itself.
export function loadFixturePhotos(): PhotoData[] {
  if (cachedPhotos !== null) return cachedPhotos
  const code = transpile(readFileSync(new URL('data.ts.txt', fixtureDirectory), 'utf8'))
  const body = code.replace(/^export\s+/gm, '')
  if (!body.includes('const photoGalleryData')) throw new Error('unexpected data fixture shape')
  cachedPhotos = new Function(`${body}\nreturn photoGalleryData`)() as PhotoData[]
  return cachedPhotos
}

function loadIndexCode() {
  if (cachedIndexCode !== null) return cachedIndexCode
  const code = transpile(readFileSync(new URL('index.ts.txt', fixtureDirectory), 'utf8'))
  const importPattern = /^import\s*\{\s*photoGalleryData\s*\}\s*from\s*["']\.\/data["'];?\s*$/m
  if (!importPattern.test(code)) throw new Error('fixture import line not found')
  cachedIndexCode = code.replace(importPattern, '')
  return cachedIndexCode
}

export type ReferenceGallery = FixtureModule & {
  browser: FakeBrowser
  body: FakeNode
  placeholder: FakeNode
  keydown(code: string): void
  click(clientX: number, clientY: number, target: 'prompt' | 'box' | 'background', photoIndex?: number): void
  mousemove(clientX: number, clientY: number): void
}

export function createReferenceGallery(browser: FakeBrowser, photos: PhotoData[] = loadFixturePhotos()): ReferenceGallery {
  const globals = createFixtureGlobals(browser)
  const exportsSource = `
return {
  render,
  data,
  colsBoxMaxSizeXF,
  state: () => ({anchor, windowSizeX, scrollY, animatedUntilTime, pointerX: pointer.x, pointerY: pointer.y}),
}`
  const factory = new Function(
    'photoGalleryData', 'window', 'document', 'navigator', 'requestAnimationFrame', 'HTMLElement',
    `${loadIndexCode()}\n${exportsSource}`,
  )
  const module = factory(
    photos, globals.window, globals.document, globals.navigator, globals.requestAnimationFrame, globals.HTMLElement,
  ) as FixtureModule
  // index.ts appends its scroll-extent placeholder to body before anything else.
  const placeholder = globals.body.children[0]!
  browser.documentHeight = () => Number.parseFloat(String(placeholder.style['height'])) || 0
  const background = new FakeNode('DIV')
  return {
    ...module,
    browser,
    body: globals.body,
    placeholder,
    keydown: code => browser.dispatch('keydown', {code}),
    click: (clientX, clientY, target, photoIndex = 0) => {
      const box = module.data[photoIndex]!
      const node = target === 'prompt' ? box.promptNode : target === 'box' ? box.node : background
      browser.dispatch('click', {clientX, clientY, target: node})
    },
    mousemove: (clientX, clientY) => browser.dispatch('mousemove', {clientX, clientY}),
  }
}
