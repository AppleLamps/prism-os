import savedModel from './model.json'
import {capacity, createScene, photoCaptions, type ContentKind} from './data.ts'
import {meanMovement, measureLayout, optimizeInstance, ordinaryPreferences, prepareScene, wrapLayout} from './layout.ts'
import {createRule} from './model.ts'
import {captionFont} from './text.ts'

type Method = 'wrapping' | 'perInstance' | 'shared'
const methodNames: Record<Method, string> = {wrapping: 'Wrapping', perInstance: 'Per-layout search', shared: 'Shared rule'}

function mount(document: Document) {
  function element<T extends Element>(selector: string): T {
    const found = document.querySelector<T>(selector)
    if (found === null) throw new Error(`Missing element ${selector}`)
    return found
  }
  const gallery = element<HTMLDivElement>('#gallery')
  const availableWidth = element<HTMLDivElement>('#available-width')
  const widthInput = element<HTMLInputElement>('#width')
  const countInput = element<HTMLSelectElement>('#count')
  const contentInput = element<HTMLSelectElement>('#content')
  const widthValue = element<HTMLOutputElement>('#width-value')
  const collectionName = element<HTMLHeadingElement>('#collection-name')
  const collectionStatus = element<HTMLSpanElement>('#collection-status')
  const rows = element<HTMLTableSectionElement>('#comparison-rows')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Canvas text measurement is unavailable')
  context.font = captionFont
  context.fontKerning = 'none'
  const measure = (text: string) => context.measureText(text).width
  const rule = createRule(savedModel.parameters)
  const photos = Array.from({length: capacity}, () => {
    const root = document.createElement('figure')
    root.className = 'photo'
    const image = document.createElement('div')
    image.setAttribute('role', 'img')
    const caption = document.createElement('figcaption')
    caption.className = 'photo-caption'
    root.append(image, caption)
    gallery.append(root)
    return {root, image, caption}
  })
  const metricRows = (['wrapping', 'perInstance', 'shared'] as const).map(method => {
    const row = document.createElement('tr')
    const cells = Array.from({length: 8}, () => document.createElement('td'))
    cells[0]!.textContent = methodNames[method]
    row.append(...cells)
    rows.append(row)
    return {method, row, cells}
  })
  const state = {method: 'shared' as Method, seed: 101, width: 900, count: 12, content: 'long' as ContentKind}
  let previousAvailableWidth = 0
  let scheduled = false

  function render() {
    scheduled = false
    const maximum = Math.floor(availableWidth.getBoundingClientRect().width)
    previousAvailableWidth = maximum
    widthInput.max = `${maximum}`
    const width = Math.max(160, Math.min(state.width, maximum))
    widthInput.min = `${Math.min(320, maximum)}`
    widthInput.value = `${width}`
    widthValue.value = `${width} px`
    const scene = prepareScene(createScene(state.seed, state.count, width, state.content), measure)
    const methods = {
      wrapping: () => wrapLayout(scene, ordinaryPreferences(scene)),
      perInstance: () => optimizeInstance(scene).layout,
      shared: () => wrapLayout(scene, rule.preferences(scene)),
    }
    const layouts = metricRows.map(({method, row, cells}) => {
      const start = performance.now()
      const layout = methods[method]()
      const runtime = performance.now() - start
      const metrics = measureLayout(scene, layout)
      const wider = {...scene, width: width + 1}
      let next
      switch (method) {
        case 'wrapping': next = wrapLayout(wider, ordinaryPreferences(wider)); break
        case 'perInstance': next = optimizeInstance(wider).layout; break
        case 'shared': next = wrapLayout(wider, rule.preferences(wider)); break
      }
      const values = [
        `${state.count - metrics.missingContent} / ${state.count}`,
        `${metrics.textOverflow.toFixed(1)} px`,
        `${metrics.horizontalOverflow.toFixed(1)} px`,
        metrics.preferenceLoss.toFixed(3),
        `${Math.round(metrics.height)} px`,
        `${meanMovement(layout, next).toFixed(1)} px`,
        `${runtime.toFixed(2)} ms`,
      ]
      for (let index = 0; index < values.length; index++) cells[index + 1]!.textContent = values[index]!
      row.dataset['selected'] = `${method === state.method}`
      return {method, layout}
    })
    const layout = layouts.find(entry => entry.method === state.method)!.layout
    gallery.style.width = `${width}px`
    gallery.style.height = `${layout.height}px`
    collectionName.textContent = `Collection ${state.seed}`
    collectionStatus.textContent = `${state.count} required photos / ${layout.rowCount} rows / ${Math.round(layout.height)} px tall`
    for (let index = 0; index < capacity; index++) {
      const dom = photos[index]!
      dom.root.hidden = index >= layout.items.length
      if (index >= layout.items.length) continue
      const item = layout.items[index]!
      dom.root.style.transform = `translate(${item.left}px, ${item.top}px)`
      dom.root.style.width = `${item.width}px`
      dom.root.style.height = `${item.height}px`
      dom.root.dataset['itemId'] = `${item.item.id}`
      dom.image.className = `photo-image image-${item.item.photoIndex}`
      dom.image.style.height = `${item.imageHeight}px`
      dom.image.setAttribute('aria-label', photoCaptions[item.item.photoIndex]![0])
      dom.caption.replaceChildren(...item.lines.map(line => {
        const span = document.createElement('span')
        span.textContent = line
        return span
      }))
    }
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(render)
  }
  widthInput.addEventListener('input', () => {state.width = Number(widthInput.value); schedule()})
  countInput.addEventListener('change', () => {state.count = Number(countInput.value); schedule()})
  contentInput.addEventListener('change', () => {state.content = contentInput.value as ContentKind; schedule()})
  element<HTMLButtonElement>('#next-collection').addEventListener('click', () => {state.seed++; schedule()})
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="method"]')) {
    radio.addEventListener('change', () => {state.method = radio.value as Method; schedule()})
  }
  new ResizeObserver(() => {
    if (Math.floor(availableWidth.getBoundingClientRect().width) !== previousAvailableWidth) schedule()
  }).observe(availableWidth)
  render()
}

mount(document)
