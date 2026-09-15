// Stage 6: the demo host's projection and input decoding, against fake DOM elements.
import {expect, test} from 'bun:test'
import {lineFitEpsilon, loadPretext} from './fake-canvas.ts'
import {type IndirectOSDom, createDemoMachine, createWordNodes, describeProgram, renderOutputs, toQueuedEvents} from './indirect-os-dom.ts'
import {testFont} from './paragraph.ts'
import {read} from './wires.ts'

type FakeElement = {
  style: Record<string, string | ((name: string, value: string) => void)>
  className: string
  textContent: string
  children: FakeElement[]
  parent: FakeElement | null
  appendChild: (child: FakeElement) => FakeElement
  remove: () => void
}

function createFakeElement(): FakeElement {
  const element: FakeElement = {
    style: {},
    className: '',
    textContent: '',
    children: [],
    parent: null,
    appendChild(child) {
      child.parent = element
      element.children.push(child)
      return child
    },
    remove() {
      if (element.parent !== null) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = null
    },
  }
  element.style['setProperty'] = (name, value) => {
    element.style[name] = value
  }
  return element
}
const fake = () => createFakeElement() as unknown as HTMLElement
const inspect = (element: HTMLElement) => element as unknown as FakeElement
const fakeDocument = {createElement: fake} as unknown as Pick<Document, 'createElement'>

test('raw input becomes whole-pixel queued events, and only understood keys pass', () => {
  expect(toQueuedEvents([
    {kind: 'down', clientX: 10.4, clientY: -0.2},
    {kind: 'key', key: 'Tab'},
    {kind: 'key', key: 'ArrowRight'},
    {kind: 'up', clientX: 99999, clientY: 20.6},
  ])).toEqual([{kind: 'down', x: 10, y: 0}, {kind: 'key', key: 'ArrowRight'}, {kind: 'up', x: 16_384, y: 21}])
})

test('the host projects windows, Photos, and every Notes word from the circuit outputs', async () => {
  const pretext = await loadPretext()
  const {machine, evaluator, words} = createDemoMachine(pretext.prepareWithSegments as never, lineFitEpsilon, testFont)
  const notesRoot = fake()
  const dom: IndirectOSDom = {
    windows: Array.from({length: 4}, fake),
    dockItems: Array.from({length: 4}, fake),
    photosRoot: fake(),
    backdrop: fake(),
    previousControl: fake(),
    nextControl: fake(),
    photoNodes: Array<HTMLElement | null>(12).fill(null),
    thumbnailNodes: Array<HTMLElement | null>(12).fill(null),
    wordNodes: createWordNodes(fakeDocument, notesRoot, words),
  }
  expect(inspect(notesRoot).children.map(child => child.textContent).join(' ')).toContain('This paragraph is laid out')
  let {values} = machine.stepFrame(1280, 800, 16, [])
  renderOutputs(fakeDocument, dom, read(values, machine.output))
  expect(inspect(dom.windows[0]!).style['transform']).toBe('translate3d(54px,54px,0) scale(1)')
  expect(inspect(dom.photosRoot).children.length).toBe(12)
  const notes = read(values, machine.output.notes!)
  expect(inspect(dom.wordNodes[0]!).style['transform']).toBe(`translate3d(${notes.words[0]!.x}px,${notes.words[0]!.y}px,0)`)
  expect(notes.words[0]).toMatchObject({x: 24, y: 24, visible: 1})
  // A click on Photos' grid cell 5 opens the lightbox: one photo node and a strip of thumbnails.
  values = machine.stepFrame(1280, 800, 32, [{kind: 'down', x: 862, y: 427}, {kind: 'up', x: 862, y: 427}]).values
  renderOutputs(fakeDocument, dom, read(values, machine.output))
  const classes = inspect(dom.photosRoot).children.map(child => child.className)
  expect(classes.filter(name => name.startsWith('photos-photo'))).toEqual(['photos-photo image-5'])
  expect(classes.filter(name => name.startsWith('photos-thumbnail')).length).toBeGreaterThan(3)
  expect(describeProgram(machine).layers).toBe(`${machine.tensorProgram.layers.length}`)
  expect(evaluator.tier).toBe('executor')
})
