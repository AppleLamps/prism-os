import {expect, test} from 'bun:test'
import {type IndirectOSDom, describeProgram, renderOutputs} from './indirect-os-dom.ts'
import {createIndirectOSMachine} from './indirect-os.ts'
import {type SettingsDom, renderSettings} from './settings-dom.ts'
import {createSettingsMachine} from './settings-panel.ts'
import {read} from './wires.ts'

type FakeElement = {
  style: Record<string, string | ((name: string, value: string) => void)>
  className: string
  textContent: string
  attributes: Record<string, string>
  children: FakeElement[]
  parent: FakeElement | null
  appendChild: (child: FakeElement) => FakeElement
  remove: () => void
  setAttribute: (name: string, value: string) => void
}

function createFakeElement(): FakeElement {
  const element: FakeElement = {
    style: {},
    className: '',
    textContent: '',
    attributes: {},
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
    setAttribute(name, value) {
      element.attributes[name] = value
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

test('the IndirectOS host projects named outputs and creates photo nodes only while visible', () => {
  const machine = createIndirectOSMachine()
  const dom: IndirectOSDom = {
    windows: Array.from({length: 4}, fake),
    dockItems: Array.from({length: 4}, fake),
    photosRoot: fake(),
    backdrop: fake(),
    previousControl: fake(),
    nextControl: fake(),
    photoNodes: Array<HTMLElement | null>(12).fill(null),
    thumbnailNodes: Array<HTMLElement | null>(12).fill(null),
  }
  let values = machine.step(1280, 800, 16)
  renderOutputs(fakeDocument, dom, read(values, machine.output))
  expect(inspect(dom.windows[0]!).style['transform']).toBe('translate3d(54px,54px,0) scale(1)')
  expect(inspect(dom.windows[3]!).style['zIndex']).toBe('14')
  expect(inspect(dom.windows[3]!).style['--focused']).toBe('1')
  const root = inspect(dom.photosRoot)
  expect(root.children.map(child => child.className)).toEqual(Array.from({length: 12}, (_, item) => `photos-photo image-${item}`))
  expect(root.children[0]!.children[0]!.textContent).toBe('Misty Lake')

  const photo = read(values, machine.output).photos.photos[2]!
  machine.photoClick(photo.left + photo.width / 2, photo.top + photo.height / 2)
  values = machine.step(1280, 800, 32)
  renderOutputs(fakeDocument, dom, read(values, machine.output))
  const classes = root.children.map(child => child.className)
  expect(classes.filter(name => name.startsWith('photos-photo'))).toEqual(['photos-photo image-2'])
  expect(classes.filter(name => name.startsWith('photos-thumbnail')).length).toBeGreaterThan(3)
  expect(describeProgram(machine.tensorProgram).values).toBe('201 inputs · 429 outputs · 5,253 activations')
})

test('the settings host projects the panel, switches, segments, and slider', () => {
  const machine = createSettingsMachine()
  const dom: SettingsDom = {
    panel: fake(), title: fake(), rows: Array.from({length: 3}, fake), switches: Array.from({length: 3}, fake), knobs: Array.from({length: 3}, fake),
    segments: Array.from({length: 3}, fake), pill: fake(), track: fake(), fill: fake(), sliderKnob: fake(), reset: fake(),
  }
  renderSettings(dom, read(machine.step(1280, 800, 16), machine.output))
  expect(inspect(dom.panel).style['transform']).toBe('translate3d(460px,206px,0)')
  expect(dom.switches.map(node => inspect(node).attributes['aria-checked'])).toEqual(['true', 'false', 'false'])
  expect(dom.segments.map(node => inspect(node).style['--selected'])).toEqual(['1', '0', '0'])
  expect(inspect(dom.title).textContent).toBe('Settings · volume 60%')
  // The circuit multiplies in FP32, so fround(0.6) * 320 rounds to exactly 192.
  expect(inspect(dom.fill).style['width']).toBe('192px')
})
