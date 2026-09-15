// A settings panel that IndirectOS does not have, written with the notation:
// three toggles, a segmented control, a slider, and a reset button, with
// springs and hover. Spring state is stored in normalized units (0..1 along a
// switch, segment index, slider value), so a viewport resize moves the panel
// without animating anything; pixels are computed only at projection.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {
  anyNumber,
  bit,
  constant,
  createOutputValidator,
  createSourceTable,
  event,
  input,
  leafWires,
  list,
  nonNegative,
  oneHot,
  state,
  unitInterval,
} from './table.ts'
import {type Rect, createNotation} from './wires.ts'

export const toggleCount = 3
export const segmentCount = 3
export const defaults = {toggles: [1, 0, 0], segment: 0, slider: 0.6} as const
const smallPixel = [0, 1024] as const

// category: declarations
export const settingsCells = {
  viewportWidth: input([0, 16_384], 1280),
  viewportHeight: input([0, 16_384], 800),
  unit: constant(1, [1, 1]),
  frameTime: input(nonNegative),
  previousFrameTime: state(nonNegative),
  timeInitialized: bit(),
  down: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  move: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  up: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  pointer: {x: state(anyNumber), y: state(anyNumber)},
  layout: {
    margin: constant(16, smallPixel),
    maxWidth: constant(360, smallPixel),
    padding: constant(20, smallPixel),
    headerHeight: constant(56, smallPixel),
    rowHeight: constant(52, smallPixel),
    switchWidth: constant(44, smallPixel),
    switchHeight: constant(26, smallPixel),
    knobInset: constant(2, smallPixel),
    segmentHeight: constant(32, smallPixel),
    sliderHeight: constant(28, smallPixel),
    buttonWidth: constant(96, smallPixel),
    buttonHeight: constant(32, smallPixel),
  },
  springs: {
    stiffness: constant(650, nonNegative),
    damping: constant(45, nonNegative),
    maxFrameDuration: constant(32, [0, 64]),
    settleDistance: constant(0.001, nonNegative),
    settleSpeed: constant(0.001, nonNegative),
    settleDistanceScale: constant(1000, nonNegative),
    settleSpeedScale: constant(1000, nonNegative),
  },
  toggles: list(toggleCount, index => ({on: bit(defaults.toggles[index]), knob: state(anyNumber, defaults.toggles[index]), velocity: state(anyNumber)})),
  segment: {selected: oneHot(list(segmentCount, index => bit(Number(index === defaults.segment)))), pill: state(anyNumber, defaults.segment), velocity: state(anyNumber)},
  slider: {value: state(unitInterval, defaults.slider), dragging: bit(), knob: state(anyNumber, defaults.slider), velocity: state(anyNumber)},
}

// category: behavior
export function buildSettingsPanel() {
  const table = createSourceTable()
  const cells = table.allocate('', settingsCells)
  const circuit = table.createCircuit()
  const $ = createNotation(circuit, cells.unit)
  const {sum, sub, scale, half, relu, mul, min, max, clamp, clamp01, not, select, rect, hit, zero, unit, assume} = $
  const layout = cells.layout

  const frameDuration = assume(mul(cells.timeInitialized, clamp(sub(cells.frameTime, cells.previousFrameTime), zero, cells.springs.maxFrameDuration)), 0, 64)
  // Declaring the timestep nonnegative up front keeps every spring product a single ReGLU.
  const springs = {...cells.springs, timestep: assume(scale(frameDuration, 0.001 / 4), 0, 0.016)}
  table.next(cells.previousFrameTime, cells.frameTime)
  table.next(cells.timeInitialized, unit)

  const down = {x: cells.down.x, y: cells.down.y}
  const baseline = select(cells.down.active, cells.pointer, down)
  const moved = select(cells.move.active, baseline, {x: cells.move.x, y: cells.move.y})
  const pointer = select(cells.up.active, moved, {x: cells.up.x, y: cells.up.y})
  table.next(cells.pointer, pointer)
  const pressed = (box: Rect) => mul(cells.down.active, hit(down, box))
  const hovered = (box: Rect) => hit(pointer, box)

  // Rows: three toggles, the segmented control, the slider, then the reset button.
  const panelWidth = min(layout.maxWidth, relu(sum(cells.viewportWidth, [layout.margin, -2])))
  const panelHeight = sum(layout.headerHeight, [layout.rowHeight, 6], layout.padding)
  const panel = rect(half(sub(cells.viewportWidth, panelWidth)), max(layout.margin, half(sub(cells.viewportHeight, panelHeight))), panelWidth, panelHeight)
  const contentLeft = sum(panel.left, layout.padding)
  const contentWidth = relu(sum(panelWidth, [layout.padding, -2]))
  const contentRight = sum(contentLeft, contentWidth)
  const rowTop = (row: number) => sum(panel.top, layout.headerHeight, [layout.rowHeight, row])
  const centeredTop = (row: number, height: Wire) => sum(rowTop(row), [layout.rowHeight, 0.5], [height, -0.5])

  const resetButton = rect(sub(contentRight, layout.buttonWidth), centeredTop(5, layout.buttonHeight), layout.buttonWidth, layout.buttonHeight)
  const reset = pressed(resetButton)
  const orDefault = (next: Wire, defaultValue: number) => select(reset, next, $.constant(defaultValue))

  const toggles = cells.toggles.map((toggle, index) => {
    const row = rect(panel.left, rowTop(index), panelWidth, layout.rowHeight)
    const on = orDefault($.toggle(toggle.on, pressed(row)), defaults.toggles[index]!)
    const knob = $.spring(toggle.knob, toggle.velocity, on, springs)
    table.next(toggle, {on, knob: knob.position, velocity: knob.velocity})
    const track = rect(sub(contentRight, layout.switchWidth), centeredTop(index, layout.switchHeight), layout.switchWidth, layout.switchHeight)
    const travel = sub(layout.switchWidth, layout.switchHeight)
    const fill = clamp01(knob.position)
    return {
      row: {...row, hovered: hovered(row)},
      track,
      knob: rect(sum(track.left, layout.knobInset, mul(travel, fill)), sum(track.top, layout.knobInset), sum(layout.switchHeight, [layout.knobInset, -2]), sum(layout.switchHeight, [layout.knobInset, -2])),
      on,
      fill,
      active: knob.active,
    }
  })

  const segmentTop = centeredTop(3, layout.segmentHeight)
  const segmentWidth = scale(contentWidth, 1 / segmentCount)
  const segmentBoxes = list(segmentCount, index => rect(sum(contentLeft, [segmentWidth, index]), segmentTop, segmentWidth, layout.segmentHeight))
  const segmentPresses = segmentBoxes.map(pressed)
  // Segments share edges, and a hit needs half a pixel of depth, so at most one press is active.
  const anySegmentPress = assume(sum(...segmentPresses), 0, 1)
  const selected = cells.segment.selected.map((choice, index) =>
    orDefault(select(anySegmentPress, choice, segmentPresses[index]!), Number(index === defaults.segment)))
  const pill = $.spring(cells.segment.pill, cells.segment.velocity, $.lookup(selected, list(segmentCount, index => index)), springs)
  table.next(cells.segment, {selected, pill: pill.position, velocity: pill.velocity})

  const track = rect(contentLeft, centeredTop(4, layout.sliderHeight), contentWidth, layout.sliderHeight)
  const dragging = select(cells.down.active, cells.slider.dragging, pressed(track))
  // Dividing by a width known only at runtime needs the Newton reciprocal.
  const inverseWidth = $.reciprocal(assume(max(track.width, unit), 1, 16_384), 1, 16_384)
  const pointerValue = clamp01(mul(sub(pointer.x, track.left), inverseWidth))
  const value = orDefault(select(dragging, cells.slider.value, pointerValue), defaults.slider)
  const sliderSpring = $.spring(cells.slider.knob, cells.slider.velocity, value, springs)
  // Pin the knob to the pointer while dragging.
  const knob = select(dragging, sliderSpring.position, value)
  table.next(cells.slider, {value, dragging: mul(dragging, not(cells.up.active)), knob, velocity: select(dragging, sliderSpring.velocity, zero)})
  const knobCenter = sum(track.left, mul(track.width, clamp01(knob)))

  const output = {
    panel,
    toggles: toggles.map(({active: _, ...toggle}) => toggle),
    segments: segmentBoxes.map((box, index) => ({...box, selected: selected[index]!, hovered: hovered(box)})),
    pill: rect(sum(contentLeft, mul(segmentWidth, pill.position)), segmentTop, segmentWidth, layout.segmentHeight),
    slider: {
      track,
      fill: sub(knobCenter, track.left),
      knob: rect(sum(knobCenter, [layout.sliderHeight, -0.5]), track.top, layout.sliderHeight, layout.sliderHeight),
      value,
      dragging,
    },
    reset: {...resetButton, hovered: hovered(resetButton)},
    animationActive: $.or(...toggles.map(toggle => toggle.active), pill.active, mul(not(dragging), sliderSpring.active)),
  }
  return {table, cells, circuit, output, ...table.finish()}
}
export type SettingsOutput = ReturnType<typeof buildSettingsPanel>['output']

// category: validation
const flag = [0, 1] as const
const outputContract = {
  toggles: {on: flag, fill: flag, row: {hovered: flag}},
  segments: {selected: flag, hovered: flag},
  slider: {value: flag, dragging: flag},
  reset: {hovered: flag},
  animationActive: flag,
}

// category: host
export function createSettingsMachine() {
  const built = buildSettingsPanel()
  const {circuit, output, nextSource, cells} = built
  const source = new Float32Array(built.initialSource)
  const nextValues = new Float32Array(source.length)
  const validateOutput = createOutputValidator('settings', output, outputContract)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([...nextSource, ...leafWires(output)])
  const receivePointer = (latch: {active: Wire, x: Wire, y: Wire}, x: number, y: number) => {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[latch.active] = 1
    source[latch.x] = x
    source[latch.y] = y
  }
  return {
    ...built,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number, frameTime: number) {
      source[cells.viewportWidth] = viewportWidth
      source[cells.viewportHeight] = viewportHeight
      source[cells.frameTime] = frameTime
      built.validate(source)
      const values = circuit.evaluateTensor(source)
      for (let offset = 0; offset < source.length; offset++) nextValues[offset] = values[nextSource[offset]!]!
      built.validate(nextValues)
      validateOutput(values)
      source.set(nextValues)
      return values
    },
    pointerDown: (x: number, y: number) => receivePointer(cells.down, x, y),
    pointerMove: (x: number, y: number) => receivePointer(cells.move, x, y),
    pointerUp: (x: number, y: number) => receivePointer(cells.up, x, y),
  }
}
export type SettingsMachine = ReturnType<typeof createSettingsMachine>
