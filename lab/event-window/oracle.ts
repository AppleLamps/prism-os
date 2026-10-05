// Plain TypeScript reference for the event-window experiment: four interactive
// rectangles in one viewport, written in the chenguini style (one tick function,
// centralized numeric state). This file is the ground truth the circuit must match
// bit-for-bit; it must stay independent of the circuit code.
//
// Behavior, precisely:
// - A frame carries at most one pointer event (down, move, or up) or none.
// - Pointer-down hit-tests against the rectangles the user saw on the PREVIOUS
//   frame (`seenGeometry`), not against geometry recomputed after this frame's
//   state changes. A point hits a rectangle only strictly inside its edges
//   (left < x < left + width), matching the production circuit's convention.
//   When rectangles overlap, a maximized rectangle wins over normal ones, and
//   the lowest index wins within each group.
// - Focus follows pointer-down: the hit rectangle becomes focused; pointer-down
//   on empty space clears focus.
// - Each rectangle has two regions: the title bar (pointer y within `titleHeight`
//   of the rectangle's displayed top edge) and the body (the rest). The relation
//   table says what each region does: whether a drag from that region moves the
//   rectangle, and whether a click on that region toggles maximized.
// - A drag begins when the pointer, while pressed, moves beyond the slop
//   threshold (Chebyshev distance from the press point strictly greater than
//   `slop`, checked on move events only). Crossing the slop threshold cancels the
//   click regardless of region. The press then owns the pointer until release:
//   the rectangle grabbed at press time follows the pointer even when the pointer
//   passes over other rectangles. A maximized rectangle never moves.
// - A pointer-down-and-up that stays within slop is a click. A click toggles the
//   rectangle's maximized state only if the rectangle was already focused BEFORE
//   the press (the first click on an unfocused rectangle only focuses it), and
//   only if the pressed region's relation cell enables the toggle.
// - The dragged position commits into stored state only at release; between the
//   press and the release, the displayed position is a pure function of the
//   latched grab point and the live pointer. Dragged positions clamp to the
//   viewport.
// - A maximized rectangle displays as the full viewport; its stored normal
//   geometry is untouched and returns when maximized toggles off.

export const rectangleCount = 4

export type PointerEventKind = 'down' | 'move' | 'up'

export type FrameInput = {kind: PointerEventKind, x: number, y: number} | null

export type Geometry = {left: number, top: number, width: number, height: number}

export type RectangleSetup = {
  width: number
  height: number
  initialLeft: number
  initialTop: number
}

export type RelationTable = {
  dragFromTitle: boolean
  dragFromBody: boolean
  clickTogglesFromTitle: boolean
  clickTogglesFromBody: boolean
}

export type BehaviorConfig = {
  viewportWidth: number
  viewportHeight: number
  slop: number
  titleHeight: number
  rectangles: RectangleSetup[]
  relations: RelationTable
}

export type OracleState = {
  pointerX: number
  pointerY: number
  pressed: boolean
  pressX: number
  pressY: number
  // -1 while no rectangle is latched (press on empty space, or before any press).
  // Latched values persist after release; `pressed` gates their meaning.
  pressedRectangle: number
  grabLeft: number
  grabTop: number
  pressOnTitle: boolean
  pressWasFocused: boolean
  pressOnMaximized: boolean
  slopExceeded: boolean
  rectangleLeft: number[]
  rectangleTop: number[]
  maximized: boolean[]
  focused: number
  // The rectangles as displayed on the previous frame; pointer-down hit-tests
  // against these.
  seenGeometry: Geometry[]
}

export type FrameOutput = {
  displayed: Geometry[]
  dragOwner: number
  focused: number
  maximized: boolean[]
  pressed: boolean
  slopExceeded: boolean
}

export function createOracleState(config: BehaviorConfig): OracleState {
  validateBehaviorConfig(config)
  const state: OracleState = {
    pointerX: 0,
    pointerY: 0,
    pressed: false,
    pressX: 0,
    pressY: 0,
    pressedRectangle: -1,
    grabLeft: 0,
    grabTop: 0,
    pressOnTitle: false,
    pressWasFocused: false,
    pressOnMaximized: false,
    slopExceeded: false,
    rectangleLeft: config.rectangles.map(rectangle => rectangle.initialLeft),
    rectangleTop: config.rectangles.map(rectangle => rectangle.initialTop),
    maximized: config.rectangles.map(() => false),
    focused: -1,
    seenGeometry: [],
  }
  state.seenGeometry = computeDisplayedGeometry(config, state, -1)
  return state
}

export function oracleTick(
  config: BehaviorConfig,
  state: OracleState,
  input: FrameInput,
): FrameOutput {
  if (input !== null) {
    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) {
      throw new Error('pointer coordinates must be integers')
    }
    state.pointerX = input.x
    state.pointerY = input.y
  }

  if (input?.kind === 'down') {
    if (state.pressed) throw new Error('pointer-down arrived while already pressed')
    const hit = hitRectangle(state, input.x, input.y)
    state.pressed = true
    state.pressX = input.x
    state.pressY = input.y
    state.pressedRectangle = hit
    state.slopExceeded = false
    if (hit >= 0) {
      const seen = state.seenGeometry[hit]!
      state.grabLeft = state.rectangleLeft[hit]!
      state.grabTop = state.rectangleTop[hit]!
      state.pressOnTitle = input.y - seen.top < config.titleHeight
      state.pressWasFocused = state.focused === hit
      state.pressOnMaximized = state.maximized[hit]!
      state.focused = hit
    } else {
      state.grabLeft = 0
      state.grabTop = 0
      state.pressOnTitle = false
      state.pressWasFocused = false
      state.pressOnMaximized = false
      state.focused = -1
    }
  } else if (input?.kind === 'move') {
    if (state.pressed) {
      const distance = Math.max(
        Math.abs(input.x - state.pressX),
        Math.abs(input.y - state.pressY),
      )
      if (distance > config.slop) state.slopExceeded = true
    }
  } else if (input?.kind === 'up') {
    if (!state.pressed) throw new Error('pointer-up arrived while not pressed')
    const owner = currentDragOwner(config, state)
    if (owner >= 0) {
      const dragged = draggedPosition(config, state, owner)
      state.rectangleLeft[owner] = dragged.left
      state.rectangleTop[owner] = dragged.top
    }
    const rectangle = state.pressedRectangle
    if (
      rectangle >= 0
      && !state.slopExceeded
      && state.pressWasFocused
      && regionClickToggles(config, state.pressOnTitle)
    ) {
      state.maximized[rectangle] = !state.maximized[rectangle]!
    }
    state.pressed = false
    state.slopExceeded = false
  }

  const dragOwner = currentDragOwner(config, state)
  const displayed = computeDisplayedGeometry(config, state, dragOwner)
  state.seenGeometry = displayed
  return {
    displayed,
    dragOwner,
    focused: state.focused,
    maximized: [...state.maximized],
    pressed: state.pressed,
    slopExceeded: state.slopExceeded,
  }
}

// A maximized rectangle wins over normal ones; the lowest index wins within
// each group. The slot index is the declared tiebreaking field.
function hitRectangle(state: OracleState, x: number, y: number): number {
  for (let index = 0; index < rectangleCount; index++) {
    if (state.maximized[index]! && pointStrictlyInside(state.seenGeometry[index]!, x, y)) {
      return index
    }
  }
  for (let index = 0; index < rectangleCount; index++) {
    if (!state.maximized[index]! && pointStrictlyInside(state.seenGeometry[index]!, x, y)) {
      return index
    }
  }
  return -1
}

function pointStrictlyInside(geometry: Geometry, x: number, y: number): boolean {
  return (
    x > geometry.left
    && x < geometry.left + geometry.width
    && y > geometry.top
    && y < geometry.top + geometry.height
  )
}

function currentDragOwner(config: BehaviorConfig, state: OracleState): number {
  if (
    state.pressed
    && state.pressedRectangle >= 0
    && state.slopExceeded
    && !state.pressOnMaximized
    && regionDragEnabled(config, state.pressOnTitle)
  ) {
    return state.pressedRectangle
  }
  return -1
}

function regionDragEnabled(config: BehaviorConfig, onTitle: boolean): boolean {
  return onTitle ? config.relations.dragFromTitle : config.relations.dragFromBody
}

function regionClickToggles(config: BehaviorConfig, onTitle: boolean): boolean {
  return onTitle ? config.relations.clickTogglesFromTitle : config.relations.clickTogglesFromBody
}

function draggedPosition(config: BehaviorConfig, state: OracleState, owner: number) {
  const rectangle = config.rectangles[owner]!
  return {
    left: clamp(
      state.grabLeft + state.pointerX - state.pressX,
      0,
      config.viewportWidth - rectangle.width,
    ),
    top: clamp(
      state.grabTop + state.pointerY - state.pressY,
      0,
      config.viewportHeight - rectangle.height,
    ),
  }
}

// Match the circuit's clamp macro: raise to the minimum first, then cap.
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function computeDisplayedGeometry(
  config: BehaviorConfig,
  state: OracleState,
  dragOwner: number,
): Geometry[] {
  return config.rectangles.map((rectangle, index) => {
    if (state.maximized[index]!) {
      return {left: 0, top: 0, width: config.viewportWidth, height: config.viewportHeight}
    }
    if (index === dragOwner) {
      const dragged = draggedPosition(config, state, index)
      return {left: dragged.left, top: dragged.top, width: rectangle.width, height: rectangle.height}
    }
    return {
      left: state.rectangleLeft[index]!,
      top: state.rectangleTop[index]!,
      width: rectangle.width,
      height: rectangle.height,
    }
  })
}

function validateBehaviorConfig(config: BehaviorConfig) {
  if (config.rectangles.length !== rectangleCount) {
    throw new Error('the behavior config must describe exactly four rectangles')
  }
  for (const rectangle of config.rectangles) {
    const values = [rectangle.width, rectangle.height, rectangle.initialLeft, rectangle.initialTop]
    if (!values.every(Number.isInteger)) {
      throw new Error('rectangle geometry must be integer pixels')
    }
    if (rectangle.width <= 0 || rectangle.height <= 0) {
      throw new Error('rectangle size must be positive')
    }
    if (rectangle.width > config.viewportWidth || rectangle.height > config.viewportHeight) {
      throw new Error('rectangles must fit inside the viewport')
    }
    if (rectangle.height <= config.titleHeight) {
      throw new Error('rectangles must be taller than the title bar so the body region exists')
    }
  }
  if (!Number.isInteger(config.slop) || config.slop < 0) {
    throw new Error('slop must be a nonnegative integer pixel count')
  }
  if (!Number.isInteger(config.titleHeight) || config.titleHeight <= 0) {
    throw new Error('title height must be a positive integer pixel count')
  }
}
