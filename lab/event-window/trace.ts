// Deterministic randomized interaction traces. The generator steps its own
// oracle replica so pointer-downs can aim at rectangles where the user actually
// sees them (including maximized rectangles covering the viewport), then the
// harnesses replay the finished trace against the oracle and the circuit.

import {
  type BehaviorConfig,
  type FrameInput,
  type RelationTable,
  createOracleState,
  oracleTick,
  rectangleCount,
} from './oracle.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

export const authoredRelations: RelationTable = {
  dragFromTitle: true,
  dragFromBody: false,
  clickTogglesFromTitle: false,
  clickTogglesFromBody: true,
}

// Randomized rectangle sizes and starting positions; overlap is allowed and the
// fixed hit priority resolves it.
export function createBehaviorConfig(
  seed: number,
  relations: RelationTable = authoredRelations,
): BehaviorConfig {
  const random = createRandom(seed)
  const viewportWidth = 1280
  const viewportHeight = 800
  const rectangles = Array.from({length: rectangleCount}, () => {
    const width = 120 + Math.floor(random() * 240)
    const height = 90 + Math.floor(random() * 190)
    return {
      width,
      height,
      initialLeft: Math.floor(random() * (viewportWidth - width)),
      initialTop: Math.floor(random() * (viewportHeight - height)),
    }
  })
  return {viewportWidth, viewportHeight, slop: 4, titleHeight: 30, rectangles, relations}
}

export function generateTrace(
  config: BehaviorConfig,
  seed: number,
  frameCount: number,
): FrameInput[] {
  const random = createRandom(seed)
  const replica = createOracleState(config)
  const frames: FrameInput[] = []
  let pointerX = Math.floor(config.viewportWidth / 2)
  let pointerY = Math.floor(config.viewportHeight / 2)

  const clampCoordinate = (value: number, limit: number) =>
    Math.max(-128, Math.min(limit + 128, Math.round(value)))

  function emit(input: FrameInput) {
    if (input !== null) {
      pointerX = input.x
      pointerY = input.y
    }
    frames.push(input)
    oracleTick(config, replica, input)
  }

  function pickPressPoint(): {x: number, y: number} {
    if (random() < 0.2) {
      // Empty space attempt (may still land on a rectangle; the oracle decides).
      return {
        x: clampCoordinate(random() * config.viewportWidth, config.viewportWidth),
        y: clampCoordinate(random() * config.viewportHeight, config.viewportHeight),
      }
    }
    const index = Math.floor(random() * rectangleCount)
    const seen = replica.seenGeometry[index]!
    const onTitle = random() < 0.5
    const x = seen.left + 1 + Math.floor(random() * Math.max(1, seen.width - 1))
    const titleSpan = Math.min(config.titleHeight, seen.height) - 1
    const y = onTitle
      ? seen.top + 1 + Math.floor(random() * Math.max(1, titleSpan))
      : seen.top + config.titleHeight + Math.floor(random() * Math.max(1, seen.height - config.titleHeight))
    return {
      x: clampCoordinate(x, config.viewportWidth),
      y: clampCoordinate(y, config.viewportHeight),
    }
  }

  function pickMoveDelta(): {dx: number, dy: number} {
    const kind = random()
    if (kind < 0.45) {
      // Near the slop threshold, on both sides of it.
      const magnitude = () => Math.floor(random() * 13) - 6
      return {dx: magnitude(), dy: magnitude()}
    }
    if (kind < 0.85) {
      const magnitude = () => {
        const size = 10 + Math.floor(random() * 190)
        return random() < 0.5 ? -size : size
      }
      return {dx: magnitude(), dy: magnitude()}
    }
    // Teleport: an abrupt jump, exercising clamping and large deltas.
    return {
      dx: Math.floor(random() * config.viewportWidth) - pointerX,
      dy: Math.floor(random() * config.viewportHeight) - pointerY,
    }
  }

  while (frames.length < frameCount) {
    if (replica.pressed) {
      const action = random()
      if (action < 0.55) {
        const {dx, dy} = pickMoveDelta()
        emit({
          kind: 'move',
          x: clampCoordinate(pointerX + dx, config.viewportWidth),
          y: clampCoordinate(pointerY + dy, config.viewportHeight),
        })
      } else if (action < 0.75) {
        // Release, usually in place, sometimes with a small jump: the up
        // position must not affect the click-versus-drag decision.
        const jitter = random() < 0.2 ? Math.floor(random() * 17) - 8 : 0
        emit({
          kind: 'up',
          x: clampCoordinate(pointerX + jitter, config.viewportWidth),
          y: clampCoordinate(pointerY + jitter, config.viewportHeight),
        })
      } else {
        emit(null)
      }
    } else {
      const action = random()
      if (action < 0.3) {
        const point = pickPressPoint()
        emit({kind: 'down', x: point.x, y: point.y})
      } else if (action < 0.45) {
        const {dx, dy} = pickMoveDelta()
        emit({
          kind: 'move',
          x: clampCoordinate(pointerX + dx, config.viewportWidth),
          y: clampCoordinate(pointerY + dy, config.viewportHeight),
        })
      } else {
        emit(null)
      }
    }
  }
  return frames.slice(0, frameCount)
}

export type TraceSummary = {
  frames: number
  downs: number
  moves: number
  ups: number
  rectanglePresses: number
  emptyPresses: number
  drags: number
  cancelledClicks: number
  clicks: number
  maximizeToggles: number
}

export function summarizeTrace(config: BehaviorConfig, trace: readonly FrameInput[]): TraceSummary {
  const state = createOracleState(config)
  const summary: TraceSummary = {
    frames: trace.length,
    downs: 0,
    moves: 0,
    ups: 0,
    rectanglePresses: 0,
    emptyPresses: 0,
    drags: 0,
    cancelledClicks: 0,
    clicks: 0,
    maximizeToggles: 0,
  }
  for (const input of trace) {
    const maximizedBefore = [...state.maximized]
    const wasDragging = state.pressed && state.slopExceeded
    const output = oracleTick(config, state, input)
    if (input === null) continue
    if (input.kind === 'down') {
      summary.downs++
      if (state.pressedRectangle >= 0) summary.rectanglePresses++
      else summary.emptyPresses++
    } else if (input.kind === 'move') {
      summary.moves++
      if (!wasDragging && output.dragOwner >= 0) summary.drags++
    } else {
      summary.ups++
      if (wasDragging) summary.cancelledClicks++
      else if (state.pressedRectangle >= 0) summary.clicks++
      for (let index = 0; index < rectangleCount; index++) {
        if (output.maximized[index] !== maximizedBefore[index]) summary.maximizeToggles++
      }
    }
  }
  return summary
}
