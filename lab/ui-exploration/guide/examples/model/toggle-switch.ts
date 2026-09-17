// A complete small app built with numeric-ui-core.ts: a toggle switch centered in the viewport. Like a native switch,
// it acts on release: a press on the track arms it, and a release on the track while it's armed flips it. A release
// off the track, or a pointercancel, disarms it without flipping. The thumb springs to its new side, and the pointer
// hovering the track sets the cursor. The builder code follows the phases of vibescript's render loop
// (vibescript's ui.md): layout and cursor, handle inputs, animation tick, commit state, DOM writes.
// toggle-switch-reference.ts is the same app as plain JavaScript, and toggle-switch.test.ts runs both over
// toggle-switch-trace.ts. Nothing in this file runs at import.
import {Circuit, type Wire, asWire, emitMinimum, emitSelect, emitSpring, invariant} from '../../../../../src/runtime/numeric-ui-core.ts'
import {emitAll, emitAtLeast, emitClampZeroOne, emitConstant, emitNot} from './helpers.ts'

export const layout = {trackWidth: 52, trackHeight: 32, thumbInset: 4, maxFrameDuration: 32} as const
export const thumbSize = layout.trackHeight - 2 * layout.thumbInset
export const thumbTravel = layout.trackWidth - layout.trackHeight
export const springParameters = {stiffness: 650, damping: 45, settleDistance: 0.001, settleSpeed: 0.001, settleScale: 1000} as const
// Pointer coordinates are declared within ±16,384 px, and the host clamps them into that range.
export const pointerLimit = 16_384

// What happens to a cell around a frame:
// - input: JS writes it before the frame, e.g. the viewport width read from the DOM. The frame keeps it.
// - event: a latch, i.e. a cell that an event handler sets to 1, e.g. downActive, with the event's coordinates in input
//   cells next to it. The frame's next value for a latch is 0, which is ui.md's "reset ephemeral events".
// - state: the frame computes its next value, e.g. whether the switch is on.
type CellPolicy = 'input' | 'event' | 'state'
export type CellSpec = {name: string, policy: CellPolicy, minimum: number, maximum: number, initial: number, exactBit: boolean}

export function buildToggleSwitch() {
  // Declarations. Like ui.md's single state object, except that each field is one number at a fixed position, with a
  // declared range and an initial value.
  const specs: CellSpec[] = []
  const cell = (name: string, policy: CellPolicy, minimum: number, maximum: number, initial = 0, exactBit = false): Wire => {
    specs.push({name, policy, minimum, maximum, initial, exactBit})
    return asWire(specs.length - 1)
  }
  const open = Number.POSITIVE_INFINITY
  const cells = {
    viewportWidth: cell('viewportWidth', 'input', 0, 16_384, 1280),
    viewportHeight: cell('viewportHeight', 'input', 0, 16_384, 800),
    frameDuration: cell('frameDuration', 'input', 0, 1000),
    // The latest pointer position, for hover. Only the latest value matters, so this is an input, not a latch. It starts
    // far outside any track.
    pointerX: cell('pointerX', 'input', -pointerLimit, pointerLimit, -pointerLimit),
    pointerY: cell('pointerY', 'input', -pointerLimit, pointerLimit, -pointerLimit),
    downActive: cell('downActive', 'event', 0, 1, 0, true),
    downX: cell('downX', 'input', -pointerLimit, pointerLimit),
    downY: cell('downY', 'input', -pointerLimit, pointerLimit),
    upActive: cell('upActive', 'event', 0, 1, 0, true),
    upX: cell('upX', 'input', -pointerLimit, pointerLimit),
    upY: cell('upY', 'input', -pointerLimit, pointerLimit),
    cancelActive: cell('cancelActive', 'event', 0, 1, 0, true),
    on: cell('on', 'state', 0, 1, 0, true),
    // 1 between a press on the track and the release or cancel that ends it.
    armed: cell('armed', 'state', 0, 1, 0, true),
    // Spring state in normalized units: 0 is the off side and 1 the on side. Pixels only appear in the DOM outputs, so
    // a viewport resize moves the track without starting an animation.
    thumbPosition: cell('thumbPosition', 'state', -open, open),
    thumbVelocity: cell('thumbVelocity', 'state', -open, open),
  }
  const circuit = new Circuit(specs.length)
  for (const [wire, spec] of specs.entries()) circuit.assumeRange(asWire(wire), spec.minimum, spec.maximum)
  const unit = emitConstant(circuit, 1)
  const zero = emitConstant(circuit, 0)

  // Layout and cursor. JS: trackLeft = viewportWidth / 2 - 26. Numbers known while building become coefficients and
  // biases. A builder may compute values in any order, as long as each operation reads values that already exist.
  const trackLeft = circuit.affine([[cells.viewportWidth, 0.5]], -layout.trackWidth / 2)
  const trackRight = circuit.affine([[cells.viewportWidth, 0.5]], layout.trackWidth / 2)
  const trackTop = circuit.affine([[cells.viewportHeight, 0.5]], -layout.trackHeight / 2)
  const trackBottom = circuit.affine([[cells.viewportHeight, 0.5]], layout.trackHeight / 2)
  // JS: x >= trackLeft && x < trackRight && y >= trackTop && y < trackBottom. Each call appends a whole hit test, so the
  // program has three of them. Pointer and track coordinates stay within 2^15 of each other, so a comparison scale of
  // 64 keeps every bit exact.
  const insideTrack = (x: Wire, y: Wire) => emitAll(circuit, [
    emitAtLeast(circuit, x, trackLeft, 64),
    emitNot(circuit, emitAtLeast(circuit, x, trackRight, 64)),
    emitAtLeast(circuit, y, trackTop, 64),
    emitNot(circuit, emitAtLeast(circuit, y, trackBottom, 64)),
  ])
  const hovered = insideTrack(cells.pointerX, cells.pointerY)

  // Handle inputs, in a fixed order: down, then up, then cancel. Each step reads the wire the previous step made, like
  // a JS render reading a local variable it just reassigned, while the cells still hold last frame's values.
  // JS: if (down) armed = insideTrack(down)
  const armedAfterDown = emitSelect(circuit, cells.downActive, cells.armed, insideTrack(cells.downX, cells.downY))
  // JS: const clicked = up && armed && insideTrack(up)
  const clicked = emitAll(circuit, [cells.upActive, armedAfterDown, insideTrack(cells.upX, cells.upY)])
  // JS: if (clicked) on = 1 - on
  const nextOn = emitSelect(circuit, clicked, cells.on, emitNot(circuit, cells.on))
  // JS: if (up || cancel) armed = false
  const nextArmed = emitAll(circuit, [armedAfterDown, emitNot(circuit, cells.upActive), emitNot(circuit, cells.cancelActive)])

  // Animation tick. The absolute clock stays in JS, which writes this frame's duration in ms. The circuit caps it at
  // 32 ms and steps the spring 4 times toward this frame's destination, as IndirectOS's emitSpring does.
  const cappedDuration = emitMinimum(circuit, cells.frameDuration, emitConstant(circuit, layout.maxFrameDuration))
  const timestep = circuit.affine([[cappedDuration, 0.001 / 4]])
  const thumb = emitSpring(
    circuit, cells.thumbPosition, nextOn, cells.thumbVelocity,
    emitConstant(circuit, springParameters.stiffness), emitConstant(circuit, springParameters.damping), timestep,
    emitConstant(circuit, springParameters.settleDistance), emitConstant(circuit, springParameters.settleSpeed),
    emitConstant(circuit, springParameters.settleScale), emitConstant(circuit, springParameters.settleScale), unit,
  )

  // Commit state: one next value per cell. Inputs keep their value, event latches go back to 0, and every state cell
  // must receive a wire.
  const nextSource: Wire[] = specs.map((spec, wire) => spec.policy === 'event' ? zero : circuit.source(wire))
  nextSource[cells.on] = nextOn
  nextSource[cells.armed] = nextArmed
  nextSource[cells.thumbPosition] = thumb.position
  nextSource[cells.thumbVelocity] = thumb.velocity
  for (const [wire, spec] of specs.entries()) {
    invariant(spec.policy !== 'state' || nextSource[wire] !== wire, `${spec.name} never received a next value`)
  }

  // Values for DOM writes and scheduling.
  const fill = emitClampZeroOne(circuit, thumb.position)
  const output = {
    trackLeft,
    trackTop,
    thumbLeft: circuit.affine([[trackLeft, 1], [fill, thumbTravel]], layout.thumbInset),
    thumbTop: circuit.affine([[trackTop, 1]], layout.thumbInset),
    fill,
    on: nextOn,
    armed: nextArmed,
    hovered,
    clicked,
    // Nonzero while the thumb still moves: JS schedules another frame.
    animationActive: thumb.active,
  }
  return {circuit, specs, cells, nextSource, output}
}

export type ToggleSwitchBuild = ReturnType<typeof buildToggleSwitch>
export type ToggleSwitchOutput = Record<keyof ToggleSwitchBuild['output'], number>
export type ToggleSwitchFrame = {viewportWidth: number, viewportHeight: number, frameDuration: number}

// Every cell finite and within its declared range, and exact bits exactly 0 or 1. The executor's own range check
// rejects NaN, but accepts Infinity in an open range and 0.5 in a 0..1 cell; this also catches those before a frame, and
// in the next-state values before they're copied back.
export function validateCells(specs: readonly CellSpec[], table: Float32Array) {
  invariant(table.length === specs.length, 'table has the wrong length')
  for (const [wire, spec] of specs.entries()) {
    const value = table[wire]!
    if (!(Number.isFinite(value) && value >= spec.minimum && value <= spec.maximum)) {
      invariant(false, `${spec.name} must be finite and within ${spec.minimum}..${spec.maximum}, got ${value}`)
    }
    if (spec.exactBit && value !== 0 && value !== 1) invariant(false, `${spec.name} must be exactly 0 or 1, got ${value}`)
  }
}

export function createToggleSwitchMachine() {
  const built = buildToggleSwitch()
  const {circuit, specs, cells, nextSource, output} = built
  const outputFields = Object.keys(output) as (keyof ToggleSwitchBuild['output'])[]
  // Compile once, for exactly the values JS reads: next-state values first, then outputs. The evaluator reuses its
  // result array, so the machine copies what it keeps before the next call.
  const roots = [...nextSource, ...outputFields.map(field => output[field])]
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = Float32Array.from(specs, spec => spec.initial)
  validateCells(specs, source)
  return {
    ...built,
    roots,
    source,
    step(frame: ToggleSwitchFrame): ToggleSwitchOutput {
      // DOM reads, written into input cells.
      source[cells.viewportWidth] = frame.viewportWidth
      source[cells.viewportHeight] = frame.viewportHeight
      source[cells.frameDuration] = frame.frameDuration
      validateCells(specs, source)
      const values = evaluate(source)
      const result = {} as ToggleSwitchOutput
      outputFields.forEach((field, index) => {
        result[field] = values[specs.length + index]!
      })
      // Commit: every next-state value is copied back at once, after the whole frame is computed.
      const nextValues = values.slice(0, specs.length)
      validateCells(specs, nextValues)
      source.set(nextValues)
      return result
    },
    // Event handlers only store raw input; the next frame's evaluation reads it. A second event of the same kind in one
    // frame overwrites the first, as IndirectOS's latches do.
    pointerMove(x: number, y: number) {
      source[cells.pointerX] = x
      source[cells.pointerY] = y
    },
    pointerDown(x: number, y: number) {
      source[cells.pointerX] = x
      source[cells.pointerY] = y
      source[cells.downActive] = 1
      source[cells.downX] = x
      source[cells.downY] = y
    },
    pointerUp(x: number, y: number) {
      source[cells.pointerX] = x
      source[cells.pointerY] = y
      source[cells.upActive] = 1
      source[cells.upX] = x
      source[cells.upY] = y
    },
    pointerCancel() {
      source[cells.cancelActive] = 1
    },
  }
}

type StyledElement = {
  style: {transform: string, setProperty(name: string, value: string): void}
  setAttribute(name: string, value: string): void
}
export type ToggleSwitchDom = {track: StyledElement, thumb: StyledElement, cursorTarget: {style: {cursor: string}}}

// DOM writes: the full set of dynamic properties every frame, from output numbers only. Width, height, class and role
// are static and are set once in mountToggleSwitch.
export function renderToggleSwitch(dom: ToggleSwitchDom, output: ToggleSwitchOutput) {
  dom.track.style.transform = `translate3d(${output.trackLeft}px,${output.trackTop}px,0)`
  dom.track.style.setProperty('--fill', `${output.fill}`)
  dom.track.style.setProperty('--pressed', `${output.armed}`)
  dom.track.setAttribute('aria-checked', output.on === 1 ? 'true' : 'false')
  dom.thumb.style.transform = `translate3d(${output.thumbLeft}px,${output.thumbTop}px,0)`
  dom.cursorTarget.style.cursor = output.hovered === 1 ? 'pointer' : 'default'
}

// The browser host, in ui.md's shape: event handlers store raw input and schedule a render, render runs one evaluation,
// and another frame is scheduled only while the thumb animates. This function typechecks, and renderToggleSwitch is
// tested against fake elements, but the page itself hasn't been opened in a browser.
export function mountToggleSwitch(document: Document, window: Window) {
  const machine = createToggleSwitchMachine()
  // Static DOM chunks, created once with their static properties.
  const track = document.createElement('div')
  track.className = 'toggle-track'
  track.setAttribute('role', 'switch')
  track.style.position = 'absolute'
  track.style.width = `${layout.trackWidth}px`
  track.style.height = `${layout.trackHeight}px`
  const thumb = document.createElement('div')
  thumb.className = 'toggle-thumb'
  thumb.style.position = 'absolute'
  thumb.style.width = `${thumbSize}px`
  thumb.style.height = `${thumbSize}px`
  document.body.append(track, thumb)

  let scheduledRaf: number | null = null
  let previousFrameTime: number | null = null
  const scheduleRender = () => {
    scheduledRaf ??= window.requestAnimationFrame(render)
  }
  function render(frameTime: number) {
    scheduledRaf = null
    // The clock: only this frame's duration enters the table. After idle, the first frame has a duration of 0, so the
    // spring doesn't step through the idle time.
    const frameDuration = previousFrameTime === null ? 0 : Math.min(1000, Math.max(0, frameTime - previousFrameTime))
    const output = machine.step({
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      frameDuration,
    })
    renderToggleSwitch({track, thumb, cursorTarget: document.body}, output)
    const animating = output.animationActive > 0
    previousFrameTime = animating ? frameTime : null
    if (animating) scheduleRender()
  }
  // Quantize at the boundary: pointer coordinates on a 1/64 px grid, inside the declared range.
  const quantize = (coordinate: number) => Math.min(pointerLimit, Math.max(-pointerLimit, Math.round(coordinate * 64) / 64))
  window.addEventListener('pointermove', (event: PointerEvent) => {
    machine.pointerMove(quantize(event.clientX), quantize(event.clientY))
    scheduleRender()
  })
  window.addEventListener('pointerdown', (event: PointerEvent) => {
    machine.pointerDown(quantize(event.clientX), quantize(event.clientY))
    scheduleRender()
  })
  window.addEventListener('pointerup', (event: PointerEvent) => {
    machine.pointerUp(quantize(event.clientX), quantize(event.clientY))
    scheduleRender()
  })
  window.addEventListener('pointercancel', () => {
    machine.pointerCancel()
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)
  render(window.performance.now())
}
