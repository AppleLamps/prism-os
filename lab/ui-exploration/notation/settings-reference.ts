// An independent plain JS implementation of the settings panel in float64,
// used to check the circuit: decisions (toggle bits, the selected segment,
// dragging) must match exactly, and positions within a small tolerance.
import {defaults, segmentCount, toggleCount} from './settings-panel.ts'

export type PointerEvent = {kind: 'down' | 'move' | 'up', x: number, y: number}
type Point = {x: number, y: number}
type Box = {left: number, top: number, width: number, height: number}
type Spring = {position: number, velocity: number}

const layout = {margin: 16, maxWidth: 360, padding: 20, headerHeight: 56, rowHeight: 52, switchWidth: 44, switchHeight: 26, segmentHeight: 32, sliderHeight: 28, buttonWidth: 96, buttonHeight: 32}
const physics = {stiffness: 650, damping: 45, maxFrameDuration: 32, settle: 0.001, settleScale: 1000}

export function referenceGeometry(width: number, height: number) {
  const panelWidth = Math.min(layout.maxWidth, Math.max(0, width - 2 * layout.margin))
  const panelHeight = layout.headerHeight + 6 * layout.rowHeight + layout.padding
  const panel = {left: (width - panelWidth) / 2, top: Math.max(layout.margin, (height - panelHeight) / 2), width: panelWidth, height: panelHeight}
  const contentLeft = panel.left + layout.padding
  const contentWidth = Math.max(0, panelWidth - 2 * layout.padding)
  const rowTop = (row: number) => panel.top + layout.headerHeight + layout.rowHeight * row
  const centeredTop = (row: number, size: number) => rowTop(row) + layout.rowHeight / 2 - size / 2
  const segmentWidth = contentWidth / segmentCount
  return {
    panel,
    rows: Array.from({length: toggleCount}, (_, index) => ({left: panel.left, top: rowTop(index), width: panelWidth, height: layout.rowHeight})),
    segments: Array.from({length: segmentCount}, (_, index) => ({left: contentLeft + segmentWidth * index, top: centeredTop(3, layout.segmentHeight), width: segmentWidth, height: layout.segmentHeight})),
    track: {left: contentLeft, top: centeredTop(4, layout.sliderHeight), width: contentWidth, height: layout.sliderHeight},
    reset: {left: contentLeft + contentWidth - layout.buttonWidth, top: centeredTop(5, layout.buttonHeight), width: layout.buttonWidth, height: layout.buttonHeight},
  }
}

const depth = (point: Point, box: Box) => Math.min(point.x - box.left, box.left + box.width - point.x, point.y - box.top, box.top + box.height - point.y)
const hit = (point: Point, box: Box) => depth(point, box) >= 0.5

// True when a point sits so close to a hit threshold that FP32 rounding could flip the decision.
export function nearHitThreshold(point: Point, width: number, height: number) {
  const geometry = referenceGeometry(width, height)
  const boxes = [...geometry.rows, ...geometry.segments, geometry.track, geometry.reset]
  return boxes.some(box => Math.abs(depth(point, box) - 0.5) < 0.02)
}

function stepSpring(spring: Spring, destination: number, timestep: number) {
  let {position, velocity} = spring
  for (let step = 0; step < 4; step++) {
    const acceleration = -physics.stiffness * (position - destination) - physics.damping * velocity
    velocity += acceleration * timestep
    position += velocity * timestep
  }
  const active = Math.min(1, Math.max(0,
    Math.max(0, Math.abs(position - destination) - physics.settle) * physics.settleScale
    + Math.max(0, Math.abs(velocity) - physics.settle) * physics.settleScale))
  return {spring: {position: active * position + (1 - active) * destination, velocity: active * velocity}, active}
}

export function createSettingsReference() {
  const state = {
    on: [...defaults.toggles] as number[],
    selected: defaults.segment as number,
    value: defaults.slider as number,
    dragging: false,
    pointer: {x: 0, y: 0},
    knobs: defaults.toggles.map((on): Spring => ({position: on, velocity: 0})),
    pill: {position: defaults.segment as number, velocity: 0},
    sliderKnob: {position: defaults.slider as number, velocity: 0},
    previousFrameTime: 0,
    timeInitialized: false,
  }
  return {
    state,
    step(width: number, height: number, frameTime: number, events: readonly PointerEvent[]) {
      // Like the source table latches: only the last event of each kind in a frame survives.
      const last = (kind: PointerEvent['kind']) => events.filter(event => event.kind === kind).at(-1)
      const down = last('down')
      const move = last('move')
      const up = last('up')
      const geometry = referenceGeometry(width, height)
      const baseline = down ?? state.pointer
      const pointer = up ?? move ?? baseline
      state.pointer = {x: pointer.x, y: pointer.y}
      const pressed = (box: Box) => down !== undefined && hit(down, box)
      const reset = pressed(geometry.reset)
      state.on = state.on.map((on, index) => reset ? defaults.toggles[index]! : pressed(geometry.rows[index]!) ? 1 - on : on)
      const pressedSegment = geometry.segments.findIndex(pressed)
      state.selected = reset ? defaults.segment : pressedSegment === -1 ? state.selected : pressedSegment
      const dragging = down === undefined ? state.dragging : pressed(geometry.track)
      if (reset) state.value = defaults.slider
      else if (dragging) state.value = Math.min(1, Math.max(0, (pointer.x - geometry.track.left) / Math.max(1, geometry.track.width)))
      state.dragging = dragging && up === undefined
      const frameDuration = state.timeInitialized ? Math.min(physics.maxFrameDuration, Math.max(0, frameTime - state.previousFrameTime)) : 0
      const timestep = frameDuration * 0.001 / 4
      state.previousFrameTime = frameTime
      state.timeInitialized = true
      state.knobs = state.knobs.map((knob, index) => stepSpring(knob, state.on[index]!, timestep).spring)
      state.pill = stepSpring(state.pill, state.selected, timestep).spring
      const slider = stepSpring(state.sliderKnob, state.value, timestep).spring
      state.sliderKnob = dragging ? {position: state.value, velocity: 0} : slider
      return {
        on: [...state.on],
        selected: state.selected,
        value: state.value,
        dragging: Number(dragging),
        knobs: state.knobs.map(knob => knob.position),
        pill: state.pill.position,
        sliderKnob: state.sliderKnob.position,
        rowHovered: geometry.rows.map(row => Number(hit(pointer, row))),
        geometry,
      }
    },
  }
}
