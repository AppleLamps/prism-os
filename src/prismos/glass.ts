// Prism OS's glass: the refraction at the rims of the dock, Spotlight and Control Center,
// and the light that follows the pointer over lit glass. The glass itself is CSS (the
// --glass tokens in prism-os.css); this file adds the two things CSS can't do alone.
//
// Refraction: each lens is an SVG filter, an feImage holding a displacement map drawn for
// the element's size, then an feDisplacementMap that moves the backdrop's pixels by it.
// The map is neutral in the middle and points inward within a bezel of the rim, so the rim
// shows what lies a little further in, as the edge of a lens does. It moves pixels and
// never shifts their color, so no fringe of another hue appears. Only Chromium applies an
// SVG filter in backdrop-filter, so elsewhere, under prefers-reduced-transparency and with
// ?refraction=off, no lens is made and the CSS glass shows without the bend.
//
// Light: one pointermove listener records the pointer, and once a frame the lit element
// under it ([data-glass-light]) gets data-lit and the pointer's place in it as --light-x
// and --light-y. Nothing is written while the pointer is still or away from lit glass.

type Lens = {selector: string, id: string, scale: number}

const lenses: readonly Lens[] = [
  {selector: '.prism-dock-glass', id: 'prism-lens-dock', scale: 70},
  {selector: '.spotlight-row', id: 'prism-lens-spotlight', scale: 70},
  {selector: '.spotlight-sheet', id: 'prism-lens-results', scale: 70},
  {selector: '.prism-control-center', id: 'prism-lens-controls', scale: 60},
]

// The width of the rim that bends, in px. The map is smooth, so it's drawn at half the
// element's resolution and stretched.
const bezelPx = 20
const mapScale = 0.5
const svgNs = 'http://www.w3.org/2000/svg'

// A displacement map for a rounded rectangle, as RGBA bytes: red moves a pixel's sample
// along x and green along y, with 128 for no move. feDisplacementMap samples the backdrop
// at P + scale * (C / 255 - 0.5), so within `bezel` of the rim each pixel points inward,
// most strongly at the rim itself.
export function displacementMap(width: number, height: number, radius: number, bezel: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4)
  const halfWidth = width / 2
  const halfHeight = height / 2
  const corner = Math.max(0, Math.min(radius, halfWidth, halfHeight))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - halfWidth
      const dy = y + 0.5 - halfHeight
      const qx = Math.abs(dx) - (halfWidth - corner)
      const qy = Math.abs(dy) - (halfHeight - corner)
      // How far in from the rim the pixel is, and the unit vector that points inward.
      let depth: number
      let inwardX = 0
      let inwardY = 0
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy)
        depth = corner - length
        inwardX = -Math.sign(dx) * qx / length
        inwardY = -Math.sign(dy) * qy / length
      } else if (qx > qy) {
        depth = corner - qx
        inwardX = -Math.sign(dx)
      } else {
        depth = corner - qy
        inwardY = -Math.sign(dy)
      }
      const strength = depth >= bezel ? 0 : (1 - Math.max(0, depth) / bezel) ** 2
      const index = (y * width + x) * 4
      data[index] = channel(inwardX * strength)
      data[index + 1] = channel(inwardY * strength)
      data[index + 2] = 128
      data[index + 3] = 255
    }
  }
  return data
}

// Rounded away from 128 by magnitude, so mirrored pixels get mirrored values.
const channel = (amount: number) => 128 + Math.sign(amount) * Math.round(Math.abs(amount) * 127)

export function startGlass(document: Document, window: Window): void {
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return
  startLight(document, window)
  if (refracts(window)) startRefraction(document)
}

function refracts(window: Window): boolean {
  const brands = (window.navigator as Navigator & {userAgentData?: {brands: readonly {brand: string}[]}}).userAgentData?.brands ?? []
  return brands.some(entry => entry.brand === 'Chromium')
    && new URL(window.location.href).searchParams.get('refraction') !== 'off'
}

function startRefraction(document: Document): void {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) return
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  const defs = document.createElementNS(svgNs, 'defs')
  svg.append(defs)

  type Target = {filter: SVGFilterElement, image: SVGFEImageElement, size: string}
  const targets = new Map<Element, Target>()
  for (const lens of lenses) {
    const element = document.querySelector(lens.selector)
    if (element === null) continue
    const filter = document.createElementNS(svgNs, 'filter')
    filter.id = lens.id
    filter.setAttribute('filterUnits', 'userSpaceOnUse')
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    filter.setAttribute('x', '0')
    filter.setAttribute('y', '0')
    const image = document.createElementNS(svgNs, 'feImage')
    image.setAttribute('x', '0')
    image.setAttribute('y', '0')
    image.setAttribute('preserveAspectRatio', 'none')
    image.setAttribute('result', 'map')
    const displace = document.createElementNS(svgNs, 'feDisplacementMap')
    displace.setAttribute('in', 'SourceGraphic')
    displace.setAttribute('in2', 'map')
    displace.setAttribute('scale', String(lens.scale))
    displace.setAttribute('xChannelSelector', 'R')
    displace.setAttribute('yChannelSelector', 'G')
    filter.append(image, displace)
    defs.append(filter)
    targets.set(element, {filter, image, size: ''})
  }
  if (targets.size === 0) return
  document.body.append(svg)
  document.documentElement.classList.add('prism-refract')

  // A map is drawn again only when its element's size changes. A closed overlay has no
  // box, so it costs nothing until it opens.
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const target = targets.get(entry.target)
      const box = entry.borderBoxSize[0]
      if (target === undefined || box === undefined) continue
      const width = Math.round(box.inlineSize)
      const height = Math.round(box.blockSize)
      const size = `${width}x${height}`
      if (width === 0 || height === 0 || size === target.size) continue
      target.size = size
      const radius = Number.parseFloat(getComputedStyle(entry.target).borderTopLeftRadius) || 0
      const bezel = Math.max(1, Math.min(bezelPx, Math.min(width, height) / 2 - 1))
      const mapWidth = Math.max(1, Math.round(width * mapScale))
      const mapHeight = Math.max(1, Math.round(height * mapScale))
      canvas.width = mapWidth
      canvas.height = mapHeight
      context.putImageData(new ImageData(displacementMap(mapWidth, mapHeight, radius * mapScale, bezel * mapScale), mapWidth, mapHeight), 0, 0)
      for (const element of [target.filter, target.image]) {
        element.setAttribute('width', String(width))
        element.setAttribute('height', String(height))
      }
      target.image.setAttribute('href', canvas.toDataURL())
      if (entry.target instanceof HTMLElement) entry.target.dataset['lens'] = ''
    }
  })
  for (const element of targets.keys()) observer.observe(element, {box: 'border-box'})
}

function startLight(document: Document, window: Window): void {
  let pointer: {x: number, y: number, target: EventTarget | null} | null = null
  let frame = 0
  let lit: HTMLElement | null = null
  let lightX = Number.NaN
  let lightY = Number.NaN
  // The dock's glass sits under its tiles with pointer-events: none, so it's lit by its
  // rectangle, which changes only with the viewport.
  let dockRect: DOMRect | null = null
  window.addEventListener('resize', () => { dockRect = null }, {passive: true})

  const litAt = (x: number, y: number, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const element = target.closest<HTMLElement>('[data-glass-light]')
    if (element !== null) return element
    if (target.closest('.prism-scrim') !== null) return null
    const dock = document.querySelector<HTMLElement>('.prism-dock-glass')
    if (dock === null) return null
    dockRect ??= dock.getBoundingClientRect()
    return x >= dockRect.left && x < dockRect.right && y >= dockRect.top && y < dockRect.bottom ? dock : null
  }

  const draw = () => {
    frame = 0
    const element = pointer === null ? null : litAt(pointer.x, pointer.y, pointer.target)
    if (element !== lit) {
      lit?.removeAttribute('data-lit')
      lit = element
      lit?.setAttribute('data-lit', '')
      lightX = Number.NaN
      lightY = Number.NaN
    }
    if (lit === null || pointer === null) return
    const rect = lit.getBoundingClientRect()
    const x = Math.round(pointer.x - rect.left)
    const y = Math.round(pointer.y - rect.top)
    if (x !== lightX) lit.style.setProperty('--light-x', `${lightX = x}px`)
    if (y !== lightY) lit.style.setProperty('--light-y', `${lightY = y}px`)
  }
  const schedule = () => {
    if (frame === 0) frame = window.requestAnimationFrame(draw)
  }

  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    pointer = {x: event.clientX, y: event.clientY, target: event.target}
    schedule()
  }, {passive: true})
  document.addEventListener('pointerout', event => {
    if (event.relatedTarget !== null) return
    pointer = null
    schedule()
  }, {passive: true})
}
