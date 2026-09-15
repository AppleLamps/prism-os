import {expect, test} from 'bun:test'
import {createSettingsMachine, defaults, segmentCount, toggleCount} from './settings-panel.ts'
import {type PointerEvent, createSettingsReference, nearHitThreshold, referenceGeometry} from './settings-reference.ts'
import {createRandom} from './traces.ts'
import {read} from './wires.ts'

function createHarness() {
  const machine = createSettingsMachine()
  let time = 0
  const viewport = {width: 1280, height: 800}
  const step = (events: readonly PointerEvent[] = [], elapsed = 16) => {
    for (const event of events) {
      if (event.kind === 'down') machine.pointerDown(event.x, event.y)
      else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
      else machine.pointerUp(event.x, event.y)
    }
    time += elapsed
    return read(machine.step(viewport.width, viewport.height, time), machine.output)
  }
  const settle = () => {
    for (let frames = 1; frames <= 240; frames++) {
      const output = step()
      if (output.animationActive === 0) return {output, frames}
    }
    throw new Error('the panel did not settle')
  }
  const click = (x: number, y: number) => step([{kind: 'down', x, y}, {kind: 'up', x, y}])
  return {machine, viewport, step, settle, click, output: step()}
}

test('a click on a toggle row flips only that toggle, and its knob springs exactly to the end', () => {
  const harness = createHarness()
  const row = harness.output.toggles[2]!.row
  let output = harness.click(row.left + 40, row.top + row.height / 2)
  expect(output.toggles.map(toggle => toggle.on)).toEqual([1, 0, 1])
  expect(output.animationActive).toBe(1)
  expect(output.toggles[2]!.fill).toBeGreaterThan(0)
  expect(output.toggles[2]!.fill).toBeLessThan(1)
  const settled = harness.settle()
  output = settled.output
  expect(settled.frames).toBeLessThan(40)
  expect(output.toggles[2]!.fill).toBe(1)
  expect(output.toggles[2]!.knob.left).toBe(output.toggles[2]!.track.left + 2 + 18)
  output = harness.click(row.left + 300, row.top + 5)
  expect(output.toggles.map(toggle => toggle.on)).toEqual([1, 0, 0])
  expect(harness.settle().output.toggles[2]!.fill).toBe(0)
})

test('a segment click selects exactly one segment, and the pill settles on it', () => {
  const harness = createHarness()
  const segment = harness.output.segments[1]!
  const output = harness.click(segment.left + 10, segment.top + 10)
  expect(output.segments.map(box => box.selected)).toEqual([0, 1, 0])
  const settled = harness.settle().output
  expect(settled.pill.left).toBeCloseTo(settled.segments[1]!.left, 4)
  expect(harness.machine.source[harness.machine.cells.segment.pill]).toBe(1)
})

test('dragging the slider follows the pointer, clamps at both ends, and pins the knob', () => {
  const harness = createHarness()
  const track = harness.output.slider.track
  const y = track.top + track.height / 2
  let output = harness.step([{kind: 'down', x: track.left + track.width / 4, y}])
  expect(output.slider.dragging).toBe(1)
  expect(output.slider.value).toBeCloseTo(0.25, 5)
  expect(output.slider.knob.left).toBe(track.left + track.width / 4 - 14)
  expect(output.animationActive).toBe(0)
  output = harness.step([{kind: 'move', x: track.left + 5000, y: y + 300}])
  expect(output.slider.value).toBe(1)
  output = harness.step([{kind: 'move', x: track.left - 5000, y}])
  expect(output.slider.value).toBe(0)
  expect(output.slider.knob.left).toBe(track.left - 14)
  output = harness.step([{kind: 'move', x: track.left + 100.5, y}, {kind: 'up', x: track.left + 100.5, y}])
  expect(output.slider.value).toBeCloseTo(100.5 / track.width, 6)
  expect(harness.machine.source[harness.machine.cells.slider.dragging]).toBe(0)
  const released = output.slider.value
  output = harness.step([{kind: 'move', x: track.left + 250, y}])
  expect(output.slider.value).toBe(released)
})

test('reset restores every default and springs the knobs back', () => {
  const harness = createHarness()
  const {toggles, segments, slider, reset} = harness.output
  harness.click(toggles[0]!.row.left + 30, toggles[0]!.row.top + 20)
  harness.click(segments[2]!.left + 10, segments[2]!.top + 10)
  harness.click(slider.track.left + 30, slider.track.top + 14)
  harness.settle()
  let output = harness.click(reset.left + 10, reset.top + 10)
  expect(output.toggles.map(toggle => toggle.on)).toEqual([...defaults.toggles])
  expect(output.segments.map(box => box.selected)).toEqual([1, 0, 0])
  expect(output.slider.value).toBe(Math.fround(defaults.slider))
  expect(output.animationActive).toBe(1)
  output = harness.settle().output
  expect(output.toggles.map(toggle => toggle.fill)).toEqual([...defaults.toggles])
  expect(output.pill.left).toBe(output.segments[0]!.left)
})

test('resizing the viewport moves the panel without starting an animation', () => {
  const harness = createHarness()
  const before = harness.settle().output
  harness.viewport.width = 700
  harness.viewport.height = 500
  const after = harness.step()
  expect(after.panel.left).not.toBe(before.panel.left)
  expect(after.animationActive).toBe(0)
  expect(after.toggles.map(toggle => toggle.fill)).toEqual(before.toggles.map(toggle => toggle.fill))
})

test('random pointer traces agree with the plain JS reference', () => {
  const harness = createHarness()
  const reference = createSettingsReference()
  reference.step(harness.viewport.width, harness.viewport.height, 16, [])
  const random = createRandom(0x5e77)
  let time = 16
  let compared = 0
  const pointIn = (box: {left: number, top: number, width: number, height: number}) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const point = {x: box.left - 20 + (box.width + 40) * random(), y: box.top - 10 + (box.height + 20) * random()}
      if (!nearHitThreshold(point, harness.viewport.width, harness.viewport.height)) return point
    }
    return {x: -1000, y: -1000}
  }
  for (let frame = 0; frame < 500; frame++) {
    const choice = Math.floor(random() * 10)
    if (choice === 0) {
      harness.viewport.width = 200 + Math.floor(random() * 1400)
      harness.viewport.height = 300 + Math.floor(random() * 900)
    }
    const geometry = referenceGeometry(harness.viewport.width, harness.viewport.height)
    const events: PointerEvent[] = []
    if (choice === 1) events.push({kind: 'down', ...pointIn(geometry.rows[Math.floor(random() * toggleCount)]!)}, {kind: 'up', x: 0, y: 0})
    if (choice === 2) events.push({kind: 'down', ...pointIn(geometry.segments[Math.floor(random() * segmentCount)]!)})
    if (choice === 3) events.push({kind: 'down', ...pointIn(geometry.track)})
    if (choice === 4 || choice === 5) events.push({kind: 'move', ...pointIn(random() < 0.5 ? geometry.track : geometry.panel)})
    if (choice === 6) events.push({kind: 'up', ...pointIn(geometry.panel)})
    if (choice === 7 && random() < 0.3) events.push({kind: 'down', ...pointIn(geometry.reset)}, {kind: 'up', ...pointIn(geometry.reset)})
    if (events.at(-1)?.kind === 'up' && nearHitThreshold(events.at(-1)!, harness.viewport.width, harness.viewport.height)) events.pop()
    const elapsed = 1 + random() * 40
    time += elapsed
    const expected = reference.step(harness.viewport.width, harness.viewport.height, time, events)
    const output = harness.step(events, elapsed)
    expect(output.toggles.map(toggle => toggle.on)).toEqual(expected.on)
    expect(output.segments.map(box => box.selected)).toEqual(Array.from({length: segmentCount}, (_, index) => Number(index === expected.selected)))
    expect(output.slider.dragging).toBe(expected.dragging)
    expect(Math.abs(output.slider.value - expected.value)).toBeLessThan(1e-5)
    const source = harness.machine.source
    const cells = harness.machine.cells
    cells.toggles.forEach((toggle, index) => expect(Math.abs(source[toggle.knob]! - expected.knobs[index]!)).toBeLessThan(1e-3))
    expect(Math.abs(source[cells.segment.pill]! - expected.pill)).toBeLessThan(1e-3)
    expect(Math.abs(source[cells.slider.knob]! - expected.sliderKnob)).toBeLessThan(1e-3)
    if (!nearHitThreshold(reference.state.pointer, harness.viewport.width, harness.viewport.height)) {
      expect(output.toggles.map(toggle => toggle.row.hovered)).toEqual(expected.rowHovered)
    }
    compared++
  }
  expect(compared).toBe(500)
})
