// Differential drivers: generate pointer input on the fly from the reference's
// own projection (presses land on cards or the box most of the time), feed the
// same frames to the JS reference and to the circuit machine, and compare.
import {validateOneHotGroups} from '../../../../../numeric-ui-core.ts'
import {createRandom, hash} from './common.ts'
import {buildCards, createCardsMachine, type CardsCircuit, type CardsFrameInput} from './cards.ts'
import {createCardsState, renderCards, type CardsEvents} from './cards-reference.ts'
import {buildFlick, createFlickMachine, type FlickCircuit} from './flick.ts'
import {createFlickState, pipH, pipW, renderFlick} from './flick-reference.ts'

const gridMs = 1 / 64

export function demoCardSizes(cardCount: number) {
  // The demo's heights, 30 + hash(i * 2) * 150, quantized to 1/64 px.
  return Array.from({length: cardCount}, (_, i) => Math.round((30 + hash(i * 2) * 150) * 64) / 64)
}

function frameDelta(random: () => number) {
  const roll = random()
  if (roll < 0.6) return 16 + 11 / 16 // 60 Hz on the 1/64 ms grid
  if (roll < 0.8) return 8 + 11 / 32
  if (roll < 0.95) return 33 + 3 / 8
  if (roll < 0.99) return 150 + Math.floor(random() * 64 * 400) / 64
  return 1300 + Math.floor(random() * 64 * 400) / 64
}

// Events land within the last 4 ms before the frame, so consecutive frames' events
// are a few ms apart, like real input. Each event kind draws its own time, so the
// events of one frame aren't in order: a pointerdown can be earlier than a
// mousemove of the same frame. The card generator can also record a mousemove at
// the old pointer position and then jump the pointer onto a card for the
// pointerdown. A release soon after such a press gives release speeds in the
// hundreds of thousands of px/s (206,584 px/s on one run), which the circuits and
// the references clamp to ±2^16 px/s.
function eventTime(random: () => number, previousFrameTime: number, frameTime: number) {
  const span = Math.max(1, Math.min(4 * 64, Math.round((frameTime - previousFrameTime) / gridMs) - 1))
  return frameTime - Math.floor(random() * span) * gridMs
}

export type CardsDifferential = {
  frames: number
  decisionMismatchFrames: number
  firstDecisionMismatch: string | undefined
  maximumPositionError: number
  maximumScaleError: number
  // Frames where the circuit's stillAnimating differs from the demo's: a spring
  // settled on one side and not on the other, because the settle rule compares
  // FP32 spring state against 0.01. When nothing animates, the demo's clock
  // restarts from the frame time, so on the next frame one side steps every spring
  // 0 times and the other steps backlog + frameDelta. That shifts the animation
  // timeline of every card that is moving.
  animatingMismatchFrames: number
  firstAnimatingMismatchFrame: number | undefined
  maximumPositionErrorBeforeAnimatingMismatch: number
  presses: number
  pressesOnCards: number
  // Frames where a card was dragged before the frame and no card is after it,
  // counted from the reference's state.
  cardReleases: number
  // Releases whose velocity the reference clamped to ±2^16 px/s.
  clampedReleases: number
  reorderFrames: number
  oneHotValidatedFrames: number
}

export type CardsDifferentialOptions = {
  // Check the declared one-hot groups on the reference evaluator on every frame
  // with a pointerdown, with the event latches written, before the step.
  validateOneHotGroupsOnPressFrames?: boolean
}

export function runCardsDifferential(
  seed: number,
  cardCount: number,
  frameCount: number,
  built: CardsCircuit = buildCards(demoCardSizes(cardCount)),
  options: CardsDifferentialOptions = {},
): CardsDifferential {
  const random = createRandom(seed)
  const sizes = built.sizes
  const windowSizeX = 1024
  const reference = createCardsState(sizes, windowSizeX)
  const machine = createCardsMachine(built, windowSizeX)
  let frameTime = 5000
  let previousFrameTime = frameTime
  let pressed = false
  let pointerX = 500
  let pointerY = 200
  let velocityX = 0
  let velocityY = 0
  let lastProjection = renderCards(reference, frameTime, windowSizeX, 24)
  machine.step({frameTime, windowSizeX, events: {mouseup: null, mousemove: null, pointerdown: null}})
  if (built.layout === 'incremental') {
    // The incremental layout needs laid-out destinations, which the demo only has
    // after its first frame: copy the reference's state after that frame.
    const {cells} = built
    const source = machine.source
    reference.data.forEach((row, rank) => {
      const card = cells.cards[Number(row.id)]!
      source[card.rank] = rank
      source[card.xPos] = row.x.pos
      source[card.xVelocity] = row.x.v
      source[card.yPos] = row.y.pos
      source[card.yVelocity] = row.y.v
      source[card.scalePos] = row.scale.pos
      source[card.scaleVelocity] = row.scale.v
      source[card.destY] = row.y.dest
    })
    source[cells.animating] = reference.animatedUntilTime === null ? 0 : 1
    source[cells.backlog] = reference.animatedUntilTime === null ? 0 : frameTime - reference.animatedUntilTime
  }
  const result: CardsDifferential = {
    frames: 0, decisionMismatchFrames: 0, firstDecisionMismatch: undefined, maximumPositionError: 0, maximumScaleError: 0,
    animatingMismatchFrames: 0, firstAnimatingMismatchFrame: undefined, maximumPositionErrorBeforeAnimatingMismatch: 0,
    presses: 0, pressesOnCards: 0, cardReleases: 0, clampedReleases: 0, reorderFrames: 0, oneHotValidatedFrames: 0,
  }
  const validateGroups = (source: Float32Array) => {
    validateOneHotGroups(built.circuit, built.circuit.evaluateReference(source))
    result.oneHotValidatedFrames++
  }
  let previousOrder = lastProjection.order.join(',')
  for (let frame = 0; frame < frameCount; frame++) {
    previousFrameTime = frameTime
    frameTime += frameDelta(random)
    const events: CardsEvents = {mouseup: null, mousemove: null, pointerdown: null}
    const record = () => ({pageX: pointerX, pageY: pointerY, timeStamp: eventTime(random, previousFrameTime, frameTime)})
    const moveBy = (scale: number) => {
      velocityX = velocityX * 0.8 + (random() - 0.5) * scale
      velocityY = velocityY * 0.8 + (random() - 0.5) * scale * 1.5
      pointerX = Math.round((pointerX + velocityX) * 2) / 2
      pointerY = Math.round((pointerY + velocityY) * 2) / 2
    }
    if (!pressed) {
      if (random() < 0.3) { moveBy(20); events.mousemove = record() }
      if (random() < 0.1) {
        result.presses++
        if (random() < 0.8) {
          const card = Math.floor(random() * cardCount)
          pointerX = Math.floor(lastProjection.x[card]! + random() * 320)
          pointerY = Math.floor(lastProjection.y[card]! + random() * sizes[card]!)
          result.pressesOnCards++
        }
        events.pointerdown = record()
        pressed = true
      }
    } else {
      if (random() < 0.85) { moveBy(60); events.mousemove = record() }
      if (random() < 0.06) {
        events.mouseup = record()
        pressed = false
        if (random() < 0.05) { events.pointerdown = record(); pressed = true }
      }
    }
    const draggedBefore = reference.dragged !== null
    reference.events = {mouseup: events.mouseup, mousemove: events.mousemove, pointerdown: events.pointerdown}
    const expected = renderCards(reference, frameTime, windowSizeX, 24)
    if (draggedBefore && reference.dragged === null) result.cardReleases++
    if (expected.releaseClamped) result.clampedReleases++
    const input: CardsFrameInput = {frameTime, windowSizeX, events}
    const got = machine.step(input, options.validateOneHotGroupsOnPressFrames === true && events.pointerdown !== null ? validateGroups : undefined)
    result.frames++
    const decisionsMatch =
      got.order.join(',') === expected.order.join(',')
      && got.zIndex.every((z, c) => z === expected.zIndex[c])
      && got.dragged.every((bit, c) => bit === expected.dragged[c])
      && got.cursor === expected.cursor
      && got.pointerLength === expected.pointerLength
    if (!decisionsMatch) {
      result.decisionMismatchFrames++
      result.firstDecisionMismatch ??= JSON.stringify({frame, expected: {order: expected.order, z: expected.zIndex, dragged: expected.dragged, cursor: expected.cursor, length: expected.pointerLength}, got: {order: got.order, z: got.zIndex, dragged: got.dragged, cursor: got.cursor, length: got.pointerLength}})
    }
    let frameError = 0
    for (let c = 0; c < cardCount; c++) {
      frameError = Math.max(frameError, Math.abs(got.x[c]! - expected.x[c]!), Math.abs(got.y[c]! - expected.y[c]!))
      result.maximumScaleError = Math.max(result.maximumScaleError, Math.abs(got.scale[c]! - expected.scale[c]!))
    }
    result.maximumPositionError = Math.max(result.maximumPositionError, frameError)
    // A differing stillAnimating bit affects the next frame's steps, so this
    // frame's positions still count as before the mismatch.
    if (result.firstAnimatingMismatchFrame === undefined) {
      result.maximumPositionErrorBeforeAnimatingMismatch = Math.max(result.maximumPositionErrorBeforeAnimatingMismatch, frameError)
    }
    if (got.stillAnimating !== expected.stillAnimating) {
      result.animatingMismatchFrames++
      result.firstAnimatingMismatchFrame ??= frame
    }
    const order = expected.order.join(',')
    if (order !== previousOrder) result.reorderFrames++
    previousOrder = order
    lastProjection = expected
  }
  return result
}

export type FlickDifferential = {
  frames: number
  decisionMismatchFrames: number
  decisionMismatchesNearEdges: number
  firstDecisionMismatch: string | undefined
  maximumPositionError: number
  maximumRestError: number
  scheduleMismatchFrames: number
  // Frames where the reference goes from dragging to idle.
  flicks: number
  // Flicks whose velocity the reference clamped to ±2^16 px/s.
  clampedFlicks: number
  maximumFlickSpeed: number
}

export function runFlickDifferential(seed: number, frameCount: number, built: FlickCircuit = buildFlick()): FlickDifferential {
  const random = createRandom(seed)
  const windowW = 1280
  const windowH = 800
  const reference = createFlickState(windowW, windowH)
  const machine = createFlickMachine(built, windowW, windowH)
  let frameTime = 5000
  let previousFrameTime = frameTime
  let pressed = false
  let pointerX = 600
  let pointerY = 400
  let velocityX = 0
  let velocityY = 0
  let lastX = reference.spring1x.pos
  let lastY = reference.spring1y.pos
  const result: FlickDifferential = {frames: 0, decisionMismatchFrames: 0, decisionMismatchesNearEdges: 0, firstDecisionMismatch: undefined, maximumPositionError: 0, maximumRestError: 0, scheduleMismatchFrames: 0, flicks: 0, clampedFlicks: 0, maximumFlickSpeed: 0}
  for (let frame = 0; frame < frameCount; frame++) {
    previousFrameTime = frameTime
    frameTime += frameDelta(random)
    const events: {mouseup: {pageX: number, pageY: number, timeStamp: number} | null, mousemove: {pageX: number, pageY: number, timeStamp: number} | null, pointerdown: {pageX: number, pageY: number, timeStamp: number} | null} = {mouseup: null, mousemove: null, pointerdown: null}
    const record = () => ({pageX: pointerX, pageY: pointerY, timeStamp: eventTime(random, previousFrameTime, frameTime)})
    const moveBy = (scale: number) => {
      velocityX = velocityX * 0.9 + (random() - 0.5) * scale
      velocityY = velocityY * 0.9 + (random() - 0.5) * scale
      pointerX = Math.round((pointerX + velocityX) * 4) / 4
      pointerY = Math.round((pointerY + velocityY) * 4) / 4
    }
    if (!pressed) {
      if (random() < 0.3) { moveBy(10); events.mousemove = record() }
      if (random() < 0.08) {
        if (random() < 0.85) {
          pointerX = Math.floor(lastX + random() * pipW)
          pointerY = Math.floor(lastY + random() * pipH)
        }
        events.pointerdown = record()
        pressed = true
      }
    } else {
      if (random() < 0.9) { moveBy(50); events.mousemove = record() }
      if (random() < 0.08) { events.mouseup = record(); pressed = false }
    }
    const wasDragging = reference.mode === 'dragging'
    reference.events = {mouseup: events.mouseup, mousemove: events.mousemove, pointerdown: events.pointerdown}
    const expected = renderFlick(reference, frameTime, windowW, windowH)
    if (wasDragging && reference.mode === 'idle') result.flicks++
    if (expected.releaseClamped) result.clampedFlicks++
    const got = machine.step({frameTime, windowW, windowH, events})
    result.frames++
    const decisionsMatch = got.cursor === expected.cursor && got.showRestMarker === expected.showRestMarker && (reference.mode === 'dragging') === (got.cursor === 'grabbing')
    if (!decisionsMatch) {
      result.decisionMismatchFrames++
      if (expected.hitMargins.some(margin => margin < 0.05)) result.decisionMismatchesNearEdges++
      result.firstDecisionMismatch ??= JSON.stringify({frame, expected: {cursor: expected.cursor, marker: expected.showRestMarker, x: expected.x, y: expected.y, margins: expected.hitMargins}, got})
    }
    if (got.scheduleAnother !== expected.scheduleAnother) result.scheduleMismatchFrames++
    result.maximumPositionError = Math.max(result.maximumPositionError, Math.abs(got.x - expected.x), Math.abs(got.y - expected.y))
    result.maximumRestError = Math.max(result.maximumRestError, Math.abs(got.restX - expected.restX), Math.abs(got.restY - expected.restY))
    result.maximumFlickSpeed = Math.max(result.maximumFlickSpeed, Math.abs(reference.spring1x.v), Math.abs(reference.spring1y.v))
    lastX = expected.x
    lastY = expected.y
  }
  return result
}
