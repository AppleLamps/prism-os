// Browser demo: the gallery circuit projected onto chenglou.github.io's DOM structure.
// The photos aren't stored locally (the site loads them from Midjourney's CDN), so boxes are colored
// rectangles with each photo's aspect ratio. Add ?photos=cdn to load the original images instead.
// All logic lives in gallery-app.ts and gallery-circuit.ts, which the headless tests exercise; this
// file only creates nodes, forwards events, and applies style strings.
import {createGalleryApp, type GalleryPlatform, type GalleryView} from './gallery-app.ts'
import {measureProgram} from './kit.ts'
import {photoGalleryData} from './photo-data.ts'
import {buildGalleryCircuit} from './gallery-circuit.ts'

const useCdn = new URLSearchParams(window.location.search).get('photos') === 'cdn'
const photos = photoGalleryData

const nodes = photos.map((photo, index) => {
  const node = document.createElement('div')
  node.className = 'box'
  if (useCdn) node.style.backgroundImage = `url(https://cdn.midjourney.com/${photo.id}_384_N.webp)`
  else node.style.backgroundColor = `hsl(${(index * 137.508) % 360} 42% 36%)`
  const image = document.createElement('img')
  const prompt = document.createElement('figcaption')
  prompt.className = 'prompt'
  prompt.textContent = photo.prompt
  node.append(image, prompt)
  return {node, image, prompt}
})
const placeholder = document.createElement('div')
placeholder.style.position = 'absolute'
placeholder.style.width = '1px'
document.body.append(placeholder)
const hud = document.getElementById('hud')!

const view: GalleryView = {
  showBox(index, style) {
    const {node, image, prompt} = nodes[index]!
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
    image.style.display = useCdn ? style.imageDisplay : 'none'
    if (useCdn && style.fullResolution) {
      const source = `https://cdn.midjourney.com/${photos[index]!.id}.webp`
      if (image.src !== source) image.src = source
    }
    if (node.parentNode === null) document.body.appendChild(node)
  },
  hideBox(index) {
    const {node} = nodes[index]!
    if (node.parentNode !== null) node.remove()
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
    if (selection === null) return
    const range = document.createRange()
    range.selectNodeContents(nodes[index]!.prompt)
    selection.removeAllRanges()
    selection.addRange(range)
  },
}

const built = buildGalleryCircuit(photos)
const {stats} = measureProgram(built.circuit, built.roots)
const app = createGalleryApp(photos, platform, view, {}, built)

let scheduled = false
let averageMicroseconds = 0
function scheduleRender() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduled = false
    const started = performance.now()
    const animating = app.render(now)
    const microseconds = (performance.now() - started) * 1000
    averageMicroseconds = averageMicroseconds === 0 ? microseconds : averageMicroseconds * 0.9 + microseconds * 0.1
    hud.textContent = `${photos.length} photos, one circuit\n${stats.liveOperations.toLocaleString()} live operations, ${stats.layers} layers\n${stats.storedWeights.toLocaleString()} stored weights\nrender with DOM writes: ${Math.round(averageMicroseconds)} µs`
    if (animating) scheduleRender()
  })
}

window.addEventListener('resize', () => scheduleRender())
window.addEventListener('scroll', () => scheduleRender(), true)
window.addEventListener('popstate', () => scheduleRender())
window.addEventListener('keydown', event => {
  app.keydown(event.code)
  scheduleRender()
})
window.addEventListener('click', event => {
  const promptIndex = event.target instanceof HTMLElement && event.target.tagName === 'FIGCAPTION'
    ? nodes.findIndex(item => item.prompt === event.target)
    : -1
  app.click(event.clientX, event.clientY, promptIndex)
  scheduleRender()
})
window.addEventListener('mousemove', event => {
  app.mousemove(event.clientX, event.clientY)
  scheduleRender()
})
scheduleRender()
