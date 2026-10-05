// The toggle switch from toggle-switch.ts as plain JavaScript in float64, written the way chenguini's ui.md writes a
// render loop: event handlers only store raw input, render runs in phases, and state is committed at the end.
import {layout, pointerLimit, springParameters, thumbTravel} from './toggle-switch.ts'

type Point = {x: number, y: number}
type Events = {down: Point | null, up: Point | null, cancel: boolean}
const noEvents = (): Events => ({down: null, up: null, cancel: false})

export function createToggleSwitchReference() {
  // Centralized state, like ui.md's `st`. `events` keeps the latest event of each kind until render reads it.
  const st = {
    on: 0,
    armed: false,
    thumbPosition: 0,
    thumbVelocity: 0,
    pointer: {x: -pointerLimit, y: -pointerLimit} as Point,
    events: noEvents(),
  }

  function render(frame: {viewportWidth: number, viewportHeight: number, frameDuration: number}) {
    // Layout and cursor.
    const trackLeft = frame.viewportWidth / 2 - layout.trackWidth / 2
    const trackTop = frame.viewportHeight / 2 - layout.trackHeight / 2
    const insideTrack = (point: Point) =>
      point.x >= trackLeft && point.x < trackLeft + layout.trackWidth
      && point.y >= trackTop && point.y < trackTop + layout.trackHeight
    const hovered = insideTrack(st.pointer)

    // Handle inputs, in a fixed order: down, then up, then cancel.
    let armed = st.armed
    let on = st.on
    let clicked = false
    if (st.events.down !== null) armed = insideTrack(st.events.down)
    if (st.events.up !== null) {
      clicked = armed && insideTrack(st.events.up)
      armed = false
    }
    if (st.events.cancel) armed = false
    if (clicked) on = 1 - on

    // Animation tick: 4 semi-implicit Euler substeps of the capped frame duration, then the settle rule.
    const timestep = Math.min(frame.frameDuration, layout.maxFrameDuration) * 0.001 / 4
    let position = st.thumbPosition
    let velocity = st.thumbVelocity
    for (let step = 0; step < 4; step++) {
      const acceleration = -springParameters.stiffness * (position - on) - springParameters.damping * velocity
      velocity += acceleration * timestep
      position += velocity * timestep
    }
    const animationActive = clamp01(
      Math.max(0, Math.abs(position - on) - springParameters.settleDistance) * springParameters.settleScale
      + Math.max(0, Math.abs(velocity) - springParameters.settleSpeed) * springParameters.settleScale,
    )

    // Commit state, and reset the events.
    st.on = on
    st.armed = armed
    st.thumbPosition = animationActive * position + (1 - animationActive) * on
    st.thumbVelocity = animationActive * velocity
    st.events = noEvents()

    // Values for DOM writes.
    const fill = clamp01(st.thumbPosition)
    return {
      trackLeft,
      trackTop,
      thumbLeft: trackLeft + layout.thumbInset + thumbTravel * fill,
      thumbTop: trackTop + layout.thumbInset,
      fill,
      on,
      armed: armed ? 1 : 0,
      hovered: hovered ? 1 : 0,
      clicked: clicked ? 1 : 0,
      animationActive,
    }
  }

  return {
    st,
    render,
    // Event handlers: store raw input, nothing else.
    pointerMove(x: number, y: number) {
      st.pointer = {x, y}
    },
    pointerDown(x: number, y: number) {
      st.pointer = {x, y}
      st.events.down = {x, y}
    },
    pointerUp(x: number, y: number) {
      st.pointer = {x, y}
      st.events.up = {x, y}
    },
    pointerCancel() {
      st.events.cancel = true
    },
  }
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
