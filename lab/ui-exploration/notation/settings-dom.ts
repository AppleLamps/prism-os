// The browser host for the settings panel: event latches, the render loop, and
// projecting the named output structs onto absolutely positioned nodes.
import {invariant} from '../../../numeric-ui-core.ts'
import {type SettingsOutput, createSettingsMachine, segmentCount, toggleCount} from './settings-panel.ts'
import {read} from './wires.ts'

// category: host
type Box = {left: number, top: number, width: number, height: number}
export type SettingsDom = {
  panel: HTMLElement
  title: HTMLElement
  rows: HTMLElement[]
  switches: HTMLElement[]
  knobs: HTMLElement[]
  segments: HTMLElement[]
  pill: HTMLElement
  track: HTMLElement
  fill: HTMLElement
  sliderKnob: HTMLElement
  reset: HTMLElement
}

function place(element: HTMLElement, box: Box) {
  element.style.width = `${box.width}px`
  element.style.height = `${box.height}px`
  element.style.transform = `translate3d(${box.left}px,${box.top}px,0)`
}

export function renderSettings(dom: SettingsDom, output: SettingsOutput) {
  place(dom.panel, output.panel)
  dom.title.textContent = `Settings · volume ${Math.round(output.slider.value * 100)}%`
  output.toggles.forEach((toggle, index) => {
    place(dom.rows[index]!, toggle.row)
    dom.rows[index]!.style.setProperty('--hovered', `${toggle.row.hovered}`)
    place(dom.switches[index]!, toggle.track)
    dom.switches[index]!.style.setProperty('--fill', `${toggle.fill}`)
    dom.switches[index]!.setAttribute('aria-checked', toggle.on === 1 ? 'true' : 'false')
    place(dom.knobs[index]!, toggle.knob)
  })
  output.segments.forEach((segment, index) => {
    place(dom.segments[index]!, segment)
    dom.segments[index]!.style.setProperty('--selected', `${segment.selected}`)
    dom.segments[index]!.style.setProperty('--hovered', `${segment.hovered}`)
  })
  place(dom.pill, output.pill)
  place(dom.track, output.slider.track)
  dom.fill.style.width = `${output.slider.fill}px`
  place(dom.sliderKnob, output.slider.knob)
  dom.sliderKnob.style.setProperty('--dragging', `${output.slider.dragging}`)
  place(dom.reset, output.reset)
  dom.reset.style.setProperty('--hovered', `${output.reset.hovered}`)
}

export function mountSettings(document: Document, window: Window) {
  const machine = createSettingsMachine()
  const query = (selector: string) => {
    const node = document.querySelector<HTMLElement>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  const queryAll = (selector: string, count: number) => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)]
    invariant(nodes.length === count, `expected ${count} ${selector} nodes`)
    return nodes
  }
  const dom: SettingsDom = {
    panel: query('.settings-panel'),
    title: query('.settings-title'),
    rows: queryAll('.settings-row', toggleCount),
    switches: queryAll('.settings-switch', toggleCount),
    knobs: queryAll('.settings-knob', toggleCount),
    segments: queryAll('.settings-segment', segmentCount),
    pill: query('.settings-pill'),
    track: query('.settings-track'),
    fill: query('.settings-fill'),
    sliderKnob: query('.settings-slider-knob'),
    reset: query('.settings-reset'),
  }
  const stats = query('#settings-stats')
  const program = machine.tensorProgram
  const weights = program.layers.reduce((sum, layer) => sum + layer.weights.length, 0)
  const summary = `${machine.source.length} source cells · ${program.valueCount - program.sourceSize} live operations · ${program.layers.length} layers · ${weights} weights`

  let scheduledRaf: number | null = null
  // The frame that handles a pointerup still outputs the slider's `dragging` bit from before the release, and the
  // cleared bit only reaches the outputs on the next evaluation. So a release schedules one more frame; otherwise the
  // knob keeps its enlarged dragging look until the next pointer event.
  let releasePending = false
  const scheduleRender = () => {
    scheduledRaf ??= window.requestAnimationFrame(render)
  }
  function render(frameTime: number) {
    scheduledRaf = null
    const handlesRelease = releasePending
    releasePending = false
    const start = window.performance.now()
    const values = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime)
    const output = read(values, machine.output)
    renderSettings(dom, output)
    if (output.animationActive > 0 || handlesRelease) scheduleRender()
    stats.textContent = `${summary} · frame ${(window.performance.now() - start).toFixed(2)} ms · animating ${output.animationActive > 0 ? 'yes' : 'no'}`
  }
  const pointer = (receive: (x: number, y: number) => void) => (event: PointerEvent) => {
    receive(event.clientX, event.clientY)
    scheduleRender()
  }
  window.addEventListener('pointerdown', pointer(machine.pointerDown))
  window.addEventListener('pointermove', pointer(machine.pointerMove))
  const release = (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY)
    releasePending = true
    scheduleRender()
  }
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
  window.addEventListener('resize', scheduleRender)
  render(window.performance.now())
}
