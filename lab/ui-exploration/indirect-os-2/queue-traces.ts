// Seeded random frames for the event queue. A shadow copy of the oracle aims
// presses at what is on screen (title bars, buttons, grips, content, photos,
// thumbnails, controls, dock items), keeps the pointer stream legal, bounds the
// events and downs per evaluation, and moves each press or release off points
// where a float64 hit decision sits within 0.01 px of its threshold.
import type {QueuedEvent} from './events.ts'
import {createRandom, randomInteger} from '../input/kit.ts'
import {
  type OracleState,
  type Viewport,
  cloneOracleState,
  contentBox,
  createMargins,
  createOracleState,
  desktopLayout,
  isVisible,
  oracleEvaluationEnd,
  oracleEvent,
  oraclePhotoLayout,
  windowBox,
  windowRegions,
} from './oracle.ts'

export type QueueFrame = {viewport: Viewport, elapsed: number, events: QueuedEvent[]}

const viewports: Viewport[] = [{width: 1280, height: 800}, {width: 1280, height: 800}, {width: 900, height: 600}, {width: 1440, height: 900}, {width: 700, height: 520}, {width: 360, height: 300}]
const elapsedChoices = [0, 4, 8.3125, 16.6875, 16.6875, 16.6875, 33.375, 120, 500]

export function generateQueueTrace(options: {seed: number, frames: number, capacity: number, maximumDowns: number}): {frames: QueueFrame[], redraws: number, dropped: number} {
  const random = createRandom(options.seed)
  const shadow = createOracleState()
  let viewport = viewports[0]!
  let lastPress = {x: 600, y: 300}
  let redraws = 0
  let dropped = 0
  const frames: QueueFrame[] = []
  const jitter = (value: number, amount: number) => Math.round(value + randomInteger(random, -amount, amount))
  const inside = (box: {left: number, top: number, width: number, height: number}) => ({
    x: Math.round(box.left + 1 + random() * Math.max(0, box.width - 2)),
    y: Math.round(box.top + 1 + random() * Math.max(0, box.height - 2)),
  })

  function aimDown(state: OracleState) {
    const layout = desktopLayout(viewport)
    const roll = random()
    if (roll < 0.12) return inside(layout.dock[randomInteger(random, 0, 3)]!)
    if (roll < 0.22) return {x: jitter(lastPress.x, 2), y: jitter(lastPress.y, 2)}
    if (roll < 0.3) return {x: randomInteger(random, -20, viewport.width + 20), y: randomInteger(random, -20, viewport.height + 20)}
    const index = randomInteger(random, 0, 3)
    const window = state.windows[index]!
    const box = windowBox(layout, window)
    const regions = windowRegions(box)
    const part = random()
    if (part < 0.3) return inside(regions.drag)
    if (part < 0.5) return inside([regions.close, regions.maximize, regions.minimize][randomInteger(random, 0, 2)]!)
    if (part < 0.62) return inside(regions.resize)
    if (index === 3 && part < 0.92) {
      const content = contentBox(box)
      const photos = oraclePhotoLayout(content.width, content.height)
      const targets = state.photoFocus < 0
        ? photos.gridLeft.flatMap(left => photos.gridTop.map(top => ({left, top, width: photos.gridWidth, height: photos.gridHeight})))
        : [photos.previousControl, photos.nextControl, photos.main, ...photos.thumbnails(state.photoFocus)]
      const target = inside(targets[randomInteger(random, 0, targets.length - 1)]!)
      return {x: target.x + content.left, y: target.y + content.top}
    }
    return inside(regions.content)
  }

  for (let frameIndex = 0; frameIndex < options.frames; frameIndex++) {
    if (random() < 0.04) viewport = viewports[randomInteger(random, 0, viewports.length - 1)]!
    const layout = desktopLayout(viewport)
    const elapsed = elapsedChoices[randomInteger(random, 0, elapsedChoices.length - 1)]!
    const eventCount = random() < 0.25 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const events: QueuedEvent[] = []
    let downs = 0
    for (let slot = 0; slot < Math.min(eventCount, options.capacity); slot++) {
      let event: QueuedEvent
      if (random() < 0.15) {
        const key = random()
        event = {kind: 'key', key: key < 0.35 ? 'ArrowLeft' : key < 0.7 ? 'ArrowRight' : 'Escape'}
      } else if (shadow.press.active) {
        const roll = random()
        const reach = [3, 40, viewport.width / 2][randomInteger(random, 0, 2)]!
        if (roll < 0.5) event = {kind: 'move', x: jitter(shadow.pointer.x, reach), y: jitter(shadow.pointer.y, reach)}
        else if (roll < 0.65) event = {kind: 'move', x: shadow.press.x, y: shadow.press.y}
        else event = random() < 0.3 ? {kind: 'up', x: shadow.press.x, y: shadow.press.y} : {kind: 'up', x: shadow.pointer.x, y: shadow.pointer.y}
      } else if (random() < 0.7 && downs < options.maximumDowns) {
        const point = aimDown(shadow)
        event = {kind: 'down', x: point.x, y: point.y}
      } else {
        event = {kind: 'move', x: jitter(shadow.pointer.x, 30), y: jitter(shadow.pointer.y, 30)}
      }
      if (event.kind === 'down' || event.kind === 'up') {
        // Move the point until every hit decision it causes is far from its threshold.
        let attempt = 0
        for (; attempt < 6; attempt++) {
          const margins = createMargins()
          oracleEvent(cloneOracleState(shadow), layout, event, margins)
          if (margins.minimum >= 0.01) break
          redraws++
          event = {...event, x: event.x + randomInteger(random, -2, 2), y: event.y + randomInteger(random, -2, 2)}
        }
        if (attempt === 6) {
          dropped++
          continue
        }
      }
      oracleEvent(shadow, layout, event)
      if (event.kind === 'down') {
        downs++
        lastPress = {x: event.x, y: event.y}
      }
      events.push(event)
    }
    oracleEvaluationEnd(shadow, layout)
    frames.push({viewport, elapsed, events})
  }
  void isVisible
  return {frames, redraws, dropped}
}
