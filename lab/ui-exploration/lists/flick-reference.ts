// JS reference for gesture-flick-snap-target: a transcription of
// ~/github/vibescript/demos/gesture-flick-snap-target/index.ts render() and
// snap-layout.ts, with the demo's two superposed springs kept as they are.
// Changes: DOM reads come in as arguments, DOM writes come out as a projection,
// only mouse events and pointerdown are modeled, and the release velocity is
// clamped to ±2^16 px/s per axis, like the circuit (the demo has no clamp).
export const pipW = 120
export const pipH = 80
export const cornerPad = 20
export const decayFriction = 4.5
const msPerAnimationStep = 4
const releaseVelocityLimit = 2 ** 16 // the same limit as velocity.ts
function clampReleaseVelocity(velocity: number) {
  return Math.max(-releaseVelocityLimit, Math.min(releaseVelocityLimit, velocity))
}

type SpringConfig = {pos: number, dest: number, v: number, k: number, b: number}
function spring(pos: number, v = 0, k = 290, b = 24): SpringConfig {
  return {pos, dest: pos, v, k, b}
}
function springStep(config: SpringConfig) {
  const t = msPerAnimationStep / 1000
  const {pos, dest, v, k, b} = config
  const Fspring = -k * (pos - dest)
  const Fdamper = -b * v
  const a = Fspring + Fdamper
  const newV = v + a * t
  const newPos = pos + newV * t
  config.pos = newPos; config.v = newV
}
function springGoToEnd(config: SpringConfig) {
  config.pos = config.dest; config.v = 0
}

export function getCorners(w: number, h: number) {
  return [
    {x: cornerPad, y: cornerPad},
    {x: w - pipW - cornerPad, y: cornerPad},
    {x: cornerPad, y: h - pipH - cornerPad},
    {x: w - pipW - cornerPad, y: h - pipH - cornerPad},
  ]
}

export function nearestCorner(x: number, y: number, w: number, h: number) {
  const corners = getCorners(w, h)
  let best = corners[0]!, bestDist = Infinity
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i]!
    const d = (c.x - x) ** 2 + (c.y - y) ** 2
    if (d < bestDist) { bestDist = d; best = c }
  }
  return best
}

function decayRestPos(pos: number, velocity: number) {
  return pos + velocity / decayFriction
}

type PointerSample = {x: number, y: number, time: number}
export type FlickEventRecord = {pageX: number, pageY: number, timeStamp: number}

export type FlickState = {
  animatedUntilTime: number | null
  mode: 'idle' | 'dragging'
  showRestMarker: boolean
  spring1x: SpringConfig
  spring1y: SpringConfig
  spring2x: SpringConfig
  spring2y: SpringConfig
  restPosX: number
  restPosY: number
  dragOffsetX: number
  dragOffsetY: number
  dragPosX: number
  dragPosY: number
  pointerHistory: PointerSample[]
  events: {mouseup: FlickEventRecord | null, mousemove: FlickEventRecord | null, pointerdown: FlickEventRecord | null}
}

export function createFlickState(windowW: number, windowH: number): FlickState {
  const initCorner = getCorners(windowW, windowH)[2]!
  return {
    animatedUntilTime: null,
    mode: 'idle',
    showRestMarker: false,
    spring1x: spring(initCorner.x),
    spring1y: spring(initCorner.y),
    spring2x: spring(initCorner.x),
    spring2y: spring(initCorner.y),
    restPosX: initCorner.x,
    restPosY: initCorner.y,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragPosX: 0,
    dragPosY: 0,
    pointerHistory: [],
    events: {mouseup: null, mousemove: null, pointerdown: null},
  }
}

export type FlickProjection = {
  x: number
  y: number
  showRestMarker: boolean
  restX: number
  restY: number
  cursor: 'grabbing' | 'grab' | 'auto'
  scheduleAnother: boolean
  // edge distances of the pointer from the box used by each hit test, to flag
  // decisions that sit within FP32 drift of a boundary
  hitMargins: number[]
  // whether this frame released the box with a velocity beyond the clamp
  releaseClamped: boolean
}

export function renderFlick(st: FlickState, now: number, windowW: number, windowH: number): FlickProjection {
  const hitMargins: number[] = []
  let releaseClamped = false
  function currentPos() {
    if (st.mode === 'dragging') return {x: st.dragPosX, y: st.dragPosY}
    return {x: st.spring1x.pos + (st.spring2x.pos - st.restPosX), y: st.spring1y.pos + (st.spring2y.pos - st.restPosY)}
  }
  function hitTest(px: number, py: number) {
    const {x, y} = currentPos()
    hitMargins.push(Math.min(Math.abs(px - x), Math.abs(px - x - pipW), Math.abs(py - y), Math.abs(py - y - pipH)))
    return px >= x && px < x + pipW && py >= y && py < y + pipH
  }
  function triggerSnap(fromX: number, fromY: number, vx: number, vy: number, w: number, h: number) {
    st.showRestMarker = true
    st.restPosX = decayRestPos(fromX, vx)
    st.restPosY = decayRestPos(fromY, vy)
    const corner = nearestCorner(st.restPosX, st.restPosY, w, h)
    st.spring1x.pos = fromX; st.spring1x.dest = st.restPosX; st.spring1x.v = vx
    st.spring1y.pos = fromY; st.spring1y.dest = st.restPosY; st.spring1y.v = vy
    st.spring2x.pos = st.restPosX; st.spring2x.dest = corner.x; st.spring2x.v = 0
    st.spring2y.pos = st.restPosY; st.spring2y.dest = corner.y; st.spring2y.v = 0
    st.animatedUntilTime = null
  }

  // === step 0: process events
  let pointerX: number | undefined, pointerY: number | undefined, pointerTime: number | undefined
  if (st.events.mouseup != null) { pointerX = st.events.mouseup.pageX; pointerY = st.events.mouseup.pageY; pointerTime = st.events.mouseup.timeStamp }
  if (st.events.mousemove != null) { pointerX = st.events.mousemove.pageX; pointerY = st.events.mousemove.pageY; pointerTime = st.events.mousemove.timeStamp }
  if (st.events.pointerdown != null) { pointerX = st.events.pointerdown.pageX; pointerY = st.events.pointerdown.pageY; pointerTime = st.events.pointerdown.timeStamp }

  if (st.events.pointerdown != null && pointerX !== undefined && pointerY !== undefined && pointerTime !== undefined && hitTest(pointerX, pointerY)) {
    const cur = currentPos()
    st.mode = 'dragging'
    st.dragOffsetX = pointerX - cur.x
    st.dragOffsetY = pointerY - cur.y
    st.dragPosX = cur.x
    st.dragPosY = cur.y
    st.pointerHistory = [{x: pointerX, y: pointerY, time: pointerTime}]
  }

  if (st.mode === 'dragging' && st.events.mousemove != null && pointerX !== undefined && pointerY !== undefined && pointerTime !== undefined) {
    st.dragPosX = pointerX - st.dragOffsetX
    st.dragPosY = pointerY - st.dragOffsetY
    st.pointerHistory.push({x: pointerX, y: pointerY, time: pointerTime})
    if (st.pointerHistory.length > 20) st.pointerHistory.shift()
  }

  if (st.mode === 'dragging' && st.events.mouseup != null) {
    if (pointerX !== undefined && pointerY !== undefined && pointerTime !== undefined) {
      st.dragPosX = pointerX - st.dragOffsetX
      st.dragPosY = pointerY - st.dragOffsetY
      st.pointerHistory.push({x: pointerX, y: pointerY, time: pointerTime})
      if (st.pointerHistory.length > 20) st.pointerHistory.shift()
    }
    st.mode = 'idle'
    let vx = 0, vy = 0
    if (st.pointerHistory.length >= 2) {
      const last = st.pointerHistory[st.pointerHistory.length - 1]!
      let i = st.pointerHistory.length - 1
      while (i > 0 && last.time - st.pointerHistory[i - 1]!.time <= 100) i--
      const dt = last.time - st.pointerHistory[i]!.time
      if (dt > 0) {
        vx = (last.x - st.pointerHistory[i]!.x) / dt * 1000
        vy = (last.y - st.pointerHistory[i]!.y) / dt * 1000
      }
    }
    releaseClamped = Math.abs(vx) > releaseVelocityLimit || Math.abs(vy) > releaseVelocityLimit
    vx = clampReleaseVelocity(vx)
    vy = clampReleaseVelocity(vy)
    triggerSnap(st.dragPosX, st.dragPosY, vx, vy, windowW, windowH)
  }

  // === animation
  let stillAnimating = false
  if (st.mode !== 'dragging') {
    let newAnimatedUntilTime = st.animatedUntilTime ?? now
    const steps = Math.min(300, Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep))
    newAnimatedUntilTime += steps * msPerAnimationStep
    const allSprings = [st.spring1x, st.spring1y, st.spring2x, st.spring2y]
    for (const s of allSprings) {
      for (let i = 0; i < steps; i++) springStep(s)
      if (Math.abs(s.v) < 0.01 && Math.abs(s.dest - s.pos) < 0.01) springGoToEnd(s)
      else stillAnimating = true
    }
    st.animatedUntilTime = stillAnimating ? newAnimatedUntilTime : null
  }

  // === DOM writes (projection)
  const {x: renderX, y: renderY} = currentPos()
  const cursor = st.mode === 'dragging' ? 'grabbing'
    : (pointerX !== undefined && pointerY !== undefined && hitTest(pointerX, pointerY)) ? 'grab' : 'auto'
  st.events.mouseup = st.events.mousemove = st.events.pointerdown = null
  return {
    x: renderX,
    y: renderY,
    showRestMarker: st.showRestMarker,
    restX: st.restPosX,
    restY: st.restPosY,
    cursor,
    scheduleAnother: st.mode === 'dragging' || stillAnimating,
    hitMargins,
    releaseClamped,
  }
}
