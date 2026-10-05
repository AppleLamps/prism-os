// JS reference for draggable-cards: a transcription of
// chenguini's demos/draggable-cards/index.ts render(), kept as close to
// the original as possible. Changes:
// - the card count and heights are parameters (the demo uses 5 cards with
//   30 + hash(i * 2) * 150 heights; the port quantizes heights to 1/64 px)
// - DOM reads come in as arguments and DOM writes come out as a projection
// - only mouse events and pointerdown (touch events follow the same code paths)
// - two limits the demo doesn't have, which the circuit applies too: the pointer
//   buffer keeps its newest `pointerCapacity` samples (once the demo's buffer holds
//   more than 20 samples, each frame with an up, a move, and a down grows it by 2,
//   without limit), and the release velocity is clamped to ±2^16 px/s per axis
export const rowSizeX = 320
export const windowPaddingTop = 50
const msPerAnimationStep = 4
const releaseVelocityLimit = 2 ** 16 // the same limit as velocity.ts
function clampReleaseVelocity(velocity: number) {
  return Math.max(-releaseVelocityLimit, Math.min(releaseVelocityLimit, velocity))
}

export type SpringConfig = {pos: number, dest: number, v: number, k: number, b: number}
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
  config.pos = config.dest
  config.v = 0
}
function center(containee: number, container: number) {
  return (container - containee) / 2
}
function shouldSwapUp(pointerY: number, neighborDestY: number, neighborSizeY: number) {
  return pointerY < neighborDestY + neighborSizeY / 2
}
function shouldSwapDown(pointerY: number, neighborDestY: number, neighborSizeY: number) {
  return pointerY > neighborDestY + neighborSizeY / 2
}
function stackLayout(rowSizes: number[], paddingTop: number): number[] {
  const result: number[] = []
  let top = paddingTop
  for (const rowSize of rowSizes) {
    result.push(top)
    top += rowSize
  }
  return result
}

export type RowData = {id: string, sizeY: number, x: SpringConfig, y: SpringConfig, scale: SpringConfig}
type DragInfo = {id: string, deltaX: number, deltaY: number}
export type PointerSample = {x: number, y: number, time: number}
export type PointerEventRecord = {pageX: number, pageY: number, timeStamp: number}
export type CardsEvents = {mouseup: PointerEventRecord | null, mousemove: PointerEventRecord | null, pointerdown: PointerEventRecord | null}

export type CardsState = {
  animatedUntilTime: number | null
  dragged: DragInfo | null
  lastDragged: DragInfo | null
  pointerState: 'down' | 'up' | 'firstDown'
  pointer: PointerSample[]
  events: CardsEvents
  data: RowData[]
}

export function createCardsState(sizes: readonly number[], windowSizeX: number): CardsState {
  const st: CardsState = {
    animatedUntilTime: null,
    dragged: null,
    lastDragged: null,
    pointerState: 'up',
    pointer: [{x: 0, y: 0, time: 0}],
    events: {mouseup: null, mousemove: null, pointerdown: null},
    data: [],
  }
  for (let i = 0; i < sizes.length; i++) {
    st.data.push({id: i + '', sizeY: sizes[i]!, x: spring(center(rowSizeX, windowSizeX)), y: spring(0), scale: spring(1)})
  }
  return st
}

export type CardsProjection = {
  // indexed by card id
  x: number[]
  y: number[]
  scale: number[]
  zIndex: number[]
  dragged: boolean[]
  // card ids in data order
  order: number[]
  cursor: 'grabbing' | 'grab' | 'auto'
  stillAnimating: boolean
  pointerLength: number
  // whether this frame released a card with a velocity beyond the clamp
  releaseClamped: boolean
}

function hitTest(data: RowData[], pointer: PointerSample) {
  for (const d of data) {
    const {x, y, sizeY} = d
    if (x.pos <= pointer.x && pointer.x < x.pos + rowSizeX && y.pos <= pointer.y && pointer.y < y.pos + sizeY) return d
  }
  return null
}

export function renderCards(st: CardsState, now: number, windowSizeX: number, pointerCapacity: number): CardsProjection {
  // === step 0: process events
  if (st.events.mouseup != null) st.pointerState = 'up'
  if (st.events.mouseup != null) st.pointer.push({x: st.events.mouseup.pageX, y: st.events.mouseup.pageY, time: st.events.mouseup.timeStamp})
  if (st.events.mousemove != null) st.pointer.push({x: st.events.mousemove.pageX, y: st.events.mousemove.pageY, time: st.events.mousemove.timeStamp})
  if (st.events.pointerdown != null) {
    st.pointerState = 'firstDown'
    st.pointer.push({x: st.events.pointerdown.pageX, y: st.events.pointerdown.pageY, time: st.events.pointerdown.timeStamp})
  }
  if (st.pointer.length > pointerCapacity) st.pointer.splice(0, st.pointer.length - pointerCapacity)
  const pointerLength = st.pointer.length

  // === step 1: batched DOM reads
  const pointerLast = st.pointer.at(-1)!

  // === step 2: handle inputs-related state change
  let newDragged: DragInfo | null
  let releaseClamped = false
  if (st.pointerState === 'down') newDragged = st.dragged
  else if (st.pointerState === 'up') {
    if (st.dragged != null) {
      const dragIdx = st.data.findIndex(d => d.id === st.dragged!.id)
      let i = st.pointer.length - 1
      while (i > 0 && pointerLast.time - st.pointer[i - 1]!.time <= 100) i--
      const deltaTime = pointerLast.time - st.pointer[i]!.time
      if (deltaTime > 0) {
        const unclampedVx = (pointerLast.x - st.pointer[i]!.x) / deltaTime * 1000
        const unclampedVy = (pointerLast.y - st.pointer[i]!.y) / deltaTime * 1000
        const vx = clampReleaseVelocity(unclampedVx)
        const vy = clampReleaseVelocity(unclampedVy)
        releaseClamped = vx !== unclampedVx || vy !== unclampedVy
        st.data[dragIdx]!.x.v += vx
        st.data[dragIdx]!.y.v += vy
      }
    }
    newDragged = null
  } else {
    const hit = hitTest(st.data, pointerLast)
    if (hit != null) newDragged = {id: hit.id, deltaX: pointerLast.x - hit.x.pos, deltaY: pointerLast.y - hit.y.pos}
    else newDragged = null
  }

  // === step 3: calculate new layout & cursor
  if (newDragged != null) {
    let dragIdx = st.data.findIndex(d => d.id === newDragged.id)
    const d = st.data[dragIdx]!
    const x = pointerLast.x - newDragged.deltaX
    const y = pointerLast.y - newDragged.deltaY
    d.x.pos = d.x.dest = x + (center(rowSizeX, windowSizeX) - x) / 1.5
    d.y.pos = d.y.dest = y
    d.scale.dest = 1.1
    while (dragIdx > 0 && shouldSwapUp(pointerLast.y, st.data[dragIdx - 1]!.y.dest, st.data[dragIdx - 1]!.sizeY)) {
      [st.data[dragIdx], st.data[dragIdx - 1]] = [st.data[dragIdx - 1]!, st.data[dragIdx]!]
      dragIdx--
    }
    while (dragIdx < st.data.length - 1 && shouldSwapDown(pointerLast.y, st.data[dragIdx + 1]!.y.dest, st.data[dragIdx + 1]!.sizeY)) {
      [st.data[dragIdx], st.data[dragIdx + 1]] = [st.data[dragIdx + 1]!, st.data[dragIdx]!]
      dragIdx++
    }
  }
  const rowTops = stackLayout(st.data.map(d => d.sizeY), windowPaddingTop)
  for (let rowIndex = 0; rowIndex < st.data.length; rowIndex++) {
    const d = st.data[rowIndex]!
    const top = rowTops[rowIndex]!
    if (newDragged != null && d.id === newDragged.id) {
      // already modified above
    } else {
      d.x.dest = center(rowSizeX, windowSizeX)
      d.y.dest = top
      d.scale.dest = 1
    }
  }
  const cursor =
    newDragged != null ? 'grabbing'
    : hitTest(st.data, pointerLast) != null ? 'grab'
    : 'auto'

  // === step 4: run animation
  let newAnimatedUntilTime = st.animatedUntilTime ?? now
  const steps = Math.min(300, Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep))
  newAnimatedUntilTime += steps * msPerAnimationStep
  let stillAnimating = false
  for (const d of st.data) {
    for (const s of [d.x, d.y, d.scale]) {
      for (let i = 0; i < steps; i++) springStep(s)
      if (Math.abs(s.v) < 0.01 && Math.abs(s.dest - s.pos) < 0.01) springGoToEnd(s)
      else stillAnimating = true
    }
  }

  // === step 5: render (projection instead of DOM writes)
  const cardCount = st.data.length
  const projection: CardsProjection = {
    x: Array(cardCount).fill(0),
    y: Array(cardCount).fill(0),
    scale: Array(cardCount).fill(0),
    zIndex: Array(cardCount).fill(0),
    dragged: Array(cardCount).fill(false),
    order: st.data.map(d => Number(d.id)),
    cursor,
    stillAnimating,
    pointerLength,
    releaseClamped,
  }
  for (let i = 0; i < st.data.length; i++) {
    const d = st.data[i]!
    const id = Number(d.id)
    projection.x[id] = d.x.pos
    projection.y[id] = d.y.pos
    projection.scale[id] = d.scale.pos
    projection.zIndex[id] =
      newDragged != null && d.id === newDragged.id ? st.data.length + 2
      : st.lastDragged != null && d.id === st.lastDragged.id ? st.data.length + 1
      : i
    projection.dragged[id] = newDragged != null && d.id === newDragged.id
  }

  // === step 6: update state & prepare for next frame
  if (st.pointerState === 'firstDown') st.pointerState = 'down'
  if (st.dragged != null && newDragged == null) st.lastDragged = st.dragged
  st.dragged = newDragged
  st.animatedUntilTime = stillAnimating ? newAnimatedUntilTime : null
  if (st.pointerState === 'up') st.pointer = [{x: 0, y: 0, time: 0}]
  if (st.pointer.length > 20) st.pointer.shift()
  st.events.mouseup = st.events.mousemove = st.events.pointerdown = null
  return projection
}
