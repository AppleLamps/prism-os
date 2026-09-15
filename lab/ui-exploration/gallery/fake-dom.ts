// A small emulation of the browser surface that chenglou.github.io's index.ts touches.
// The native reference (the fixture's own render function) and the circuit app both run
// against a FakeBrowser, so they see the same viewport, scroll clamping, URL hash and
// selection log. Nothing here is interpreted by the circuit; it only stands in for the DOM.

export class FakeNode {
  tagName: string
  className = ''
  textContent = ''
  src = ''
  parentNode: FakeNode | null = null
  children: FakeNode[] = []
  styleValues = new Map<string, string>()
  style: Record<string, unknown>
  srcWrites = 0

  constructor(tagName: string) {
    this.tagName = tagName
    const values = this.styleValues
    this.style = new Proxy({}, {
      get(_target, property) {
        if (property === 'setProperty') return (name: string, value: string) => values.set(name, value)
        if (typeof property !== 'string') return undefined
        return values.get(property) ?? ''
      },
      set(_target, property, value) {
        if (typeof property === 'string') values.set(property, String(value))
        return true
      },
    })
  }

  append(...nodes: FakeNode[]) {
    for (const node of nodes) this.appendChild(node)
  }

  appendChild(node: FakeNode) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    this.children.push(node)
    return node
  }

  removeChild(node: FakeNode) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }
}

export type BrowserEvent =
  | {kind: 'keydown', code: string}
  | {kind: 'click', clientX: number, clientY: number, target: FakeNode}
  | {kind: 'mousemove', clientX: number, clientY: number}
  | {kind: 'resize'}
  | {kind: 'scroll'}
  | {kind: 'popstate'}

export class FakeBrowser {
  clientWidth: number
  clientHeight: number
  scrollX = 0
  scrollY = 0
  hash = ''
  reducedMotion = false
  // Whoever renders tells the browser how tall the document is, for scroll clamping.
  documentHeight: () => number = () => 0
  scrollToCalls = 0
  pushStateCalls = 0
  selectedNodes: FakeNode[] = []
  listeners = new Map<string, ((event: unknown) => void)[]>()
  animationFrameRequests = 0

  constructor(clientWidth: number, clientHeight: number) {
    this.clientWidth = clientWidth
    this.clientHeight = clientHeight
  }

  scrollTo(top: number) {
    this.scrollToCalls++
    const maximum = Math.max(0, this.documentHeight() - this.clientHeight)
    this.scrollY = Math.min(Math.max(0, top), maximum)
  }

  pushState(url: string) {
    this.pushStateCalls++
    const hashStart = url.indexOf('#')
    this.hash = hashStart < 0 ? '' : url.slice(hashStart)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

// The globals index.ts reads, backed by a FakeBrowser. The fixture checks
// `target instanceof HTMLElement`, so FakeNode doubles as HTMLElement.
export function createFixtureGlobals(browser: FakeBrowser) {
  const body = new FakeNode('BODY')
  const documentElement = {
    get clientWidth() { return browser.clientWidth },
    get clientHeight() { return browser.clientHeight },
    style: new FakeNode('HTML').style,
  }
  const document = {
    body,
    documentElement,
    createElement: (tagName: string) => new FakeNode(tagName.toUpperCase()),
    createRange: () => {
      const range = {node: null as FakeNode | null, selectNodeContents(node: FakeNode) { range.node = node }}
      return range
    },
  }
  const location = {
    get hash() { return browser.hash },
    pathname: '/',
    search: '',
  }
  const window = {
    get scrollX() { return browser.scrollX },
    get scrollY() { return browser.scrollY },
    scrollTo: (options: {top: number}) => browser.scrollTo(options.top),
    addEventListener: (type: string, listener: (event: unknown) => void) => browser.addEventListener(type, listener),
    matchMedia: (_query: string) => ({get matches() { return browser.reducedMotion }}),
    location,
    history: {pushState: (_state: unknown, _title: string, url: string) => browser.pushState(url)},
    getSelection: () => ({
      removeAllRanges() {},
      addRange(range: {node: FakeNode | null}) { if (range.node !== null) browser.selectedNodes.push(range.node) },
    }),
  }
  const navigator = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  }
  const requestAnimationFrame = (_callback: (now: number) => void) => {
    browser.animationFrameRequests++
    return browser.animationFrameRequests
  }
  return {window, document, navigator, requestAnimationFrame, HTMLElement: FakeNode, body}
}
