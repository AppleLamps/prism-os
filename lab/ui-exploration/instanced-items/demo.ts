// Browser demo: the photo gallery at 10,000 synthetic photos, driven by the staged program. Boxes are
// colored rectangles with each photo's aspect ratio. Query parameters: ?count=221 for the real photo
// list, or any other count for synthetic photos. All logic lives in demo-model.ts, gallery-host.ts
// and gallery-staged.ts, which headless tests exercise; this file only creates nodes, forwards
// events, and applies style strings.
import {createDemoModel, demoPhotos} from './demo-model.ts'
import type {GalleryPlatform, GalleryView} from './gallery-host.ts'

const parameters = new URLSearchParams(window.location.search)
const count = Math.max(8, Number(parameters.get('count') ?? '10000') || 10000)
const photos = demoPhotos(count)

type Nodes = {node: HTMLDivElement, prompt: HTMLElement}
const nodes: (Nodes | null)[] = photos.map(() => null)
const nodeFor = (index: number): Nodes => {
  const existing = nodes[index]
  if (existing !== null && existing !== undefined) return existing
  const node = document.createElement('div')
  node.className = 'box'
  node.style.backgroundColor = `hsl(${(index * 137.508) % 360} 42% 36%)`
  const prompt = document.createElement('figcaption')
  prompt.className = 'prompt'
  prompt.textContent = photos[index]!.prompt
  node.append(prompt)
  const created = {node, prompt}
  nodes[index] = created
  return created
}
const placeholder = document.createElement('div')
placeholder.style.position = 'absolute'
placeholder.style.width = '1px'
document.body.append(placeholder)
const hud = document.getElementById('hud')!

const view: GalleryView = {
  showBox(index, style) {
    const {node, prompt} = nodeFor(index)
    node.style.width = style.width
    node.style.height = style.height
    node.style.transform = style.transform
    node.style.filter = style.filter
    node.style.zIndex = style.zIndex
    prompt.style.top = style.promptTop
    prompt.style.overflowY = style.promptOverflowY
    prompt.style.height = style.promptHeight
    prompt.style.setProperty('line-clamp', style.lineClamp)
    prompt.style.setProperty('-webkit-line-clamp', style.lineClamp)
    if (node.parentNode === null) document.body.appendChild(node)
  },
  hideBox(index) {
    const node = nodes[index]?.node
    if (node !== undefined && node.parentNode !== null) node.remove()
  },
  setBody(cursor, overflowY, placeholderHeight) {
    document.body.style.cursor = cursor
    document.body.style.overflowY = overflowY
    placeholder.style.height = `${placeholderHeight}px`
  },
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const platform: GalleryPlatform = {
  read: () => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    reducedMotion: reducedMotion.matches,
    hash: window.location.hash,
  }),
  scrollTo: top => window.scrollTo({top}),
  pushHash: hash => window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${hash}`),
  selectPrompt: index => {
    const selection = window.getSelection()
    const prompt = nodes[index]?.prompt
    if (selection === null || prompt === undefined) return
    const range = document.createRange()
    range.selectNodeContents(prompt)
    selection.removeAllRanges()
    selection.addRange(range)
  },
}

const model = createDemoModel(photos, platform, view)

let scheduled = false
function scheduleRender() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduled = false
    const animating = model.frame(now)
    hud.textContent = model.hud()
    if (animating) scheduleRender()
  })
}

window.addEventListener('resize', () => scheduleRender())
window.addEventListener('scroll', () => scheduleRender(), true)
window.addEventListener('popstate', () => scheduleRender())
window.addEventListener('keydown', event => {
  model.app.keydown(event.code)
  scheduleRender()
})
window.addEventListener('click', event => {
  const promptIndex = event.target instanceof HTMLElement && event.target.tagName === 'FIGCAPTION'
    ? nodes.findIndex(item => item !== null && item.prompt === event.target)
    : -1
  model.app.click(event.clientX, event.clientY, promptIndex)
  scheduleRender()
})
window.addEventListener('mousemove', event => {
  model.app.mousemove(event.clientX, event.clientY)
  scheduleRender()
})
scheduleRender()
