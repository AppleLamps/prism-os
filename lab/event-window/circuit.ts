// The event-window circuit. Every frame is a pure feedforward function of
// (current input, the latch bank, stored rectangle state): no per-frame
// integration anywhere. The latch bank holds one live press record — an active
// bit, the press position, and the interaction snapshot taken when the press
// fired (which rectangle was hit, its geometry then, its region, whether it was
// focused and maximized) — plus a drag-begin latch. Dragging never accumulates:
// the displayed position is always (latched grab point + live pointer delta),
// and the stored position updates once, at release.
//
// The same builder emits two modes. 'exact' rounds every continuous threshold
// through the boolean atom, for bit-exact agreement with the oracle. 'soft'
// keeps the clamped scores, so the reference backward pass can train the
// behavior parameter cells; no boolean atom exists anywhere in the soft
// circuit, which is what makes single-frame (no unrolling) training possible.

import {
  Circuit,
  type Wire,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  emitSelect,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../../numeric-ui-core.ts'
import {
  type BehaviorConfig,
  type FrameInput,
  type Geometry,
  type OracleState,
  rectangleCount,
} from './oracle.ts'

export const sourceField = {
  unit: 0,
  viewportWidth: 1,
  viewportHeight: 2,
  // Behavior parameter cells: the trainable subset. Thresholds compare through
  // score = clamp01((difference) * sharpness + 0.5), so the decision is
  // boundary-versus-measure regardless of sharpness; sharpness only widens the
  // soft training ramp.
  slopBoundary: 3, // drag begins once Chebyshev distance from the press point reaches this
  titleBoundary: 4, // the pointer is on the title bar while (y - displayed top) stays at or below this
  dragFromTitle: 5,
  dragFromBody: 6,
  clickTogglesFromTitle: 7,
  clickTogglesFromBody: 8,
  thresholdSharpness: 9,
  // Per-frame input: at most one event bit is set.
  downActive: 10,
  moveActive: 11,
  upActive: 12,
  eventX: 13,
  eventY: 14,
  // The last seen pointer position (updated by every event).
  pointerX: 15,
  pointerY: 16,
  // The live press record: written on pointer-down, gated by pressActive.
  // Latched values persist after release; the active bit gates their meaning.
  pressActive: 17,
  pressX: 18,
  pressY: 19,
  pressRectangleStart: 20, // one-hot over the four rectangles; all zero for empty space
  grabLeft: 24,
  grabTop: 25,
  pressOnTitle: 26,
  pressWasFocused: 27,
  pressOnMaximized: 28,
  // The drag-begin latch: set by the move event that crosses the slop
  // threshold, cleared by down and up.
  slopLatch: 29,
  everPressed: 30,
  rectangleConstantsStart: 31, // width, height per rectangle
  rectangleStateStart: 39, // left, top, maximized, focused per rectangle
  archiveStart: 55, // archived press records, newest first
} as const

export const rectangleConstantField = {width: 0, height: 1, size: 2} as const
export const rectangleStateField = {left: 0, top: 1, maximized: 2, focused: 3, size: 4} as const
export const archiveField = {
  present: 0,
  x: 1,
  y: 2,
  rectangleStart: 3,
  grabLeft: 7,
  grabTop: 8,
  onTitle: 9,
  wasFocused: 10,
  onMaximized: 11,
  size: 12,
} as const

export function rectangleConstantCell(index: number, field: number) {
  invariant(index >= 0 && index < rectangleCount, 'rectangle index is invalid')
  return sourceField.rectangleConstantsStart + index * rectangleConstantField.size + field
}

export function rectangleStateCell(index: number, field: number) {
  invariant(index >= 0 && index < rectangleCount, 'rectangle index is invalid')
  return sourceField.rectangleStateStart + index * rectangleStateField.size + field
}

export function archiveCell(record: number, field: number) {
  invariant(record >= 0, 'archive record index is invalid')
  return sourceField.archiveStart + record * archiveField.size + field
}

export function sourceSize(pressRecordCount: number) {
  invariant(
    Number.isInteger(pressRecordCount) && pressRecordCount >= 1,
    'the latch bank needs at least the live press record',
  )
  return sourceField.archiveStart + (pressRecordCount - 1) * archiveField.size
}

const coordinateBound = 4096

export type CircuitMode = 'exact' | 'soft'

export type EventWindowOutput = {
  nextSource: Wire[]
  displayed: Wire[] // four rectangles, each left, top, width, height
  dragOwner: Wire[] // four bits, at most one set
}

export type EventWindowBuild = {
  circuit: Circuit
  output: EventWindowOutput
  pressRecordCount: number
}

export function buildEventWindowCircuit(
  mode: CircuitMode,
  pressRecordCount = 1,
): EventWindowBuild {
  const size = sourceSize(pressRecordCount)
  const circuit = new Circuit(size)
  declareSourceRanges(circuit, pressRecordCount)

  const unit = sourceField.unit
  const zero = circuit.affine([])
  const down = sourceField.downActive
  const move = sourceField.moveActive
  const up = sourceField.upActive

  // A continuous threshold score becomes a bit: rounded in exact mode, kept as
  // a ramp in soft mode so gradients can cross it.
  const bit = (score: Wire) => (mode === 'exact' ? circuit.boolean(score) : score)
  const clamp01 = (value: Wire) => emitClampZeroOne(circuit, value, unit)
  const complement = (value: Wire) => {
    const result = circuit.affine([[unit, 1], [value, -1]])
    circuit.assumeRange(result, 0, 1)
    return result
  }
  // bit = 1 while difference >= 0, where difference is an affine form. The 0.5
  // offset centers the rounding step on the boundary itself.
  const thresholdBit = (difference: Wire) => {
    const scaled = emitMultiply(circuit, difference, sourceField.thresholdSharpness)
    return bit(clamp01(circuit.affine([[scaled, 1]], 0.5)))
  }

  // 1. Pointer position: every event updates it.
  const anyEvent = circuit.affine([[down, 1], [move, 1], [up, 1]])
  circuit.assumeRange(anyEvent, 0, 1)
  const pointerX = emitSelect(circuit, anyEvent, sourceField.pointerX, sourceField.eventX)
  const pointerY = emitSelect(circuit, anyEvent, sourceField.pointerY, sourceField.eventY)

  // 2. Hit-testing. A pointer-down queries the rectangles the user saw on the
  // previous frame. That geometry is reconstructible from stored state alone:
  // a down event can only arrive while released, and while released the
  // displayed geometry is exactly the stored geometry (with the maximized
  // override); a drag in progress implies the pointer is already down.
  const seenGeometry: {left: Wire, top: Wire, width: Wire, height: Wire}[] = []
  const insideBits: Wire[] = []
  for (let index = 0; index < rectangleCount; index++) {
    const maximized = rectangleStateCell(index, rectangleStateField.maximized)
    const geometry = {
      left: emitSelect(circuit, maximized, rectangleStateCell(index, rectangleStateField.left), zero),
      top: emitSelect(circuit, maximized, rectangleStateCell(index, rectangleStateField.top), zero),
      width: emitSelect(
        circuit,
        maximized,
        rectangleConstantCell(index, rectangleConstantField.width),
        sourceField.viewportWidth,
      ),
      height: emitSelect(
        circuit,
        maximized,
        rectangleConstantCell(index, rectangleConstantField.height),
        sourceField.viewportHeight,
      ),
    }
    seenGeometry.push(geometry)
    const score = clamp01(emitMinimum(
      circuit,
      emitIntervalDistance(circuit, sourceField.eventX, geometry.left, geometry.width),
      emitIntervalDistance(circuit, sourceField.eventY, geometry.top, geometry.height),
    ))
    insideBits.push(bit(score))
  }
  // Fixed hit priority: maximized rectangles first, lowest index within each
  // group. The slot index enters as the declared tiebreaking field. The products
  // of two values within 0..1 stay within 0..1; stating the range explicitly is
  // needed in soft mode, where the clamped scores compose into their consumers
  // and the derived interval widens.
  const unitProduct = (a: Wire, b: Wire) => {
    const product = emitMultiply(circuit, a, b)
    circuit.assumeRange(product, 0, 1)
    return product
  }
  const priorityCandidates: Wire[] = []
  for (let index = 0; index < rectangleCount; index++) {
    priorityCandidates.push(unitProduct(
      insideBits[index]!,
      rectangleStateCell(index, rectangleStateField.maximized),
    ))
  }
  for (let index = 0; index < rectangleCount; index++) {
    priorityCandidates.push(unitProduct(
      insideBits[index]!,
      complement(rectangleStateCell(index, rectangleStateField.maximized)),
    ))
  }
  const routed = emitFirstActive(circuit, down, priorityCandidates)
  const hitRectangle: Wire[] = []
  for (let index = 0; index < rectangleCount; index++) {
    const combined = circuit.affine([[routed[index]!, 1], [routed[index + rectangleCount]!, 1]])
    circuit.assumeRange(combined, 0, 1)
    hitRectangle.push(combined)
  }
  const hitAny = circuit.affine(hitRectangle.map(wire => [wire, 1]))
  circuit.assumeRange(hitAny, 0, 1)

  // 3. The interaction snapshot for the press record: gathers over the hit
  // one-hot, all evaluated at the down event.
  const gather = (cells: readonly Wire[]) => {
    const result = circuit.affine(hitRectangle.map((mask, index) => [
      emitMultiply(circuit, mask, cells[index]!),
      1,
    ]))
    return result
  }
  const hitTop = gather(seenGeometry.map(geometry => geometry.top))
  const hitGrabLeft = gather(Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.left)))
  const hitGrabTop = gather(Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.top)))
  const hitWasFocused = gather(Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.focused)))
  const hitMaximized = gather(Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.maximized)))
  circuit.assumeRange(hitWasFocused, 0, 1)
  circuit.assumeRange(hitMaximized, 0, 1)
  // On the title bar while (eventY - displayed top) <= titleBoundary.
  const titleDifference = circuit.affine([
    [sourceField.titleBoundary, 1],
    [sourceField.eventY, -1],
    [hitTop, 1],
  ])
  const onTitleAtDown = emitMultiply(circuit, thresholdBit(titleDifference), hitAny)

  // 4. The press record write gates: latch on down, keep otherwise.
  const latchOnDown = (kept: Wire, fresh: Wire) => emitSelect(circuit, down, kept, fresh)
  const pressActive = clamp01(circuit.affine([
    [sourceField.pressActive, 1],
    [down, 1],
    [emitMultiply(circuit, up, sourceField.pressActive), -1],
  ]))
  const pressX = latchOnDown(sourceField.pressX, sourceField.eventX)
  const pressY = latchOnDown(sourceField.pressY, sourceField.eventY)
  const pressRectangle = hitRectangle.map((fresh, index) =>
    latchOnDown(sourceField.pressRectangleStart + index, fresh))
  const grabLeft = latchOnDown(sourceField.grabLeft, hitGrabLeft)
  const grabTop = latchOnDown(sourceField.grabTop, hitGrabTop)
  const pressOnTitle = latchOnDown(sourceField.pressOnTitle, onTitleAtDown)
  const pressWasFocused = latchOnDown(sourceField.pressWasFocused, hitWasFocused)
  const pressOnMaximized = latchOnDown(sourceField.pressOnMaximized, hitMaximized)
  for (const wire of [pressOnTitle, pressWasFocused, pressOnMaximized, ...pressRectangle]) {
    circuit.assumeRange(wire, 0, 1)
  }

  // 5. The drag-begin latch: the Chebyshev distance from the press point,
  // checked on move events only, sets it; down and up clear it.
  const chebyshev = emitMaximum(
    circuit,
    emitAbsolute(circuit, circuit.affine([[pointerX, 1], [pressX, -1]])),
    emitAbsolute(circuit, circuit.affine([[pointerY, 1], [pressY, -1]])),
  )
  const slopDifference = circuit.affine([[chebyshev, 1], [sourceField.slopBoundary, -1]])
  const slopCrossed = thresholdBit(slopDifference)
  const slopLatch = emitMultiply(
    circuit,
    emitMultiply(circuit, complement(down), complement(up)),
    clamp01(circuit.affine([
      [sourceField.slopLatch, 1],
      [emitMultiply(circuit, emitMultiply(circuit, move, sourceField.pressActive), slopCrossed), 1],
    ])),
  )

  // 6. What the pressed region is allowed to do, read from the relation table.
  const offTitle = complement(pressOnTitle)
  const dragEnabled = circuit.affine([
    [emitMultiply(circuit, pressOnTitle, sourceField.dragFromTitle), 1],
    [emitMultiply(circuit, offTitle, sourceField.dragFromBody), 1],
  ])
  const clickToggles = circuit.affine([
    [emitMultiply(circuit, pressOnTitle, sourceField.clickTogglesFromTitle), 1],
    [emitMultiply(circuit, offTitle, sourceField.clickTogglesFromBody), 1],
  ])
  circuit.assumeRange(dragEnabled, 0, 1)
  circuit.assumeRange(clickToggles, 0, 1)

  // 7. Drag ownership and the dragged position, purely feedforward: latched
  // grab point plus live pointer delta, clamped to the viewport.
  const ownerBase = emitMultiply(
    circuit,
    emitMultiply(circuit, slopLatch, dragEnabled),
    complement(pressOnMaximized),
  )
  const dragOwner = pressRectangle.map(mask => emitMultiply(circuit, mask, ownerBase))
  const ownerWidth = circuit.affine(pressRectangle.map((mask, index) => [
    emitMultiply(circuit, mask, rectangleConstantCell(index, rectangleConstantField.width)),
    1,
  ]))
  const ownerHeight = circuit.affine(pressRectangle.map((mask, index) => [
    emitMultiply(circuit, mask, rectangleConstantCell(index, rectangleConstantField.height)),
    1,
  ]))
  const draggedLeft = emitClampDynamic(
    circuit,
    circuit.affine([[grabLeft, 1], [pointerX, 1], [pressX, -1]]),
    zero,
    circuit.affine([[sourceField.viewportWidth, 1], [ownerWidth, -1]]),
  )
  const draggedTop = emitClampDynamic(
    circuit,
    circuit.affine([[grabTop, 1], [pointerY, 1], [pressY, -1]]),
    zero,
    circuit.affine([[sourceField.viewportHeight, 1], [ownerHeight, -1]]),
  )

  // 8. Release: the click toggles maximized (only if the press stayed within
  // slop, landed on an already-focused rectangle, and the region's relation
  // cell allows it); a drag commits its position into stored state, exactly
  // once. Both read the pre-clear slop latch.
  const upPress = emitMultiply(circuit, up, sourceField.pressActive)
  const clickIntact = complement(sourceField.slopLatch)
  const toggleBase = emitMultiply(
    circuit,
    emitMultiply(circuit, upPress, clickIntact),
    emitMultiply(circuit, pressWasFocused, clickToggles),
  )
  const commitBase = emitMultiply(
    circuit,
    emitMultiply(circuit, upPress, sourceField.slopLatch),
    emitMultiply(circuit, dragEnabled, complement(pressOnMaximized)),
  )
  const maximizedNext: Wire[] = []
  const rectangleLeftNext: Wire[] = []
  const rectangleTopNext: Wire[] = []
  for (let index = 0; index < rectangleCount; index++) {
    const maximized = rectangleStateCell(index, rectangleStateField.maximized)
    const toggle = emitMultiply(circuit, toggleBase, pressRectangle[index]!)
    const flipDirection = circuit.affine([[unit, 1], [maximized, -2]])
    const flipped = circuit.affine([
      [maximized, 1],
      [emitMultiply(circuit, toggle, flipDirection), 1],
    ])
    circuit.assumeRange(flipped, 0, 1)
    maximizedNext.push(flipped)
    const commit = emitMultiply(circuit, commitBase, pressRectangle[index]!)
    rectangleLeftNext.push(emitSelect(
      circuit,
      commit,
      rectangleStateCell(index, rectangleStateField.left),
      draggedLeft,
    ))
    rectangleTopNext.push(emitSelect(
      circuit,
      commit,
      rectangleStateCell(index, rectangleStateField.top),
      draggedTop,
    ))
  }

  // 9. Focus follows pointer-down: the hit rectangle, or nothing on empty space.
  const focusedNext = Array.from({length: rectangleCount}, (_, index) =>
    emitSelect(
      circuit,
      down,
      rectangleStateCell(index, rectangleStateField.focused),
      hitRectangle[index]!,
    ))
  for (const wire of focusedNext) circuit.assumeRange(wire, 0, 1)

  // 10. Displayed geometry: stored (or freshly committed) position, replaced by
  // the live dragged position while owned, replaced by the viewport while
  // maximized.
  const displayed: Wire[] = []
  for (let index = 0; index < rectangleCount; index++) {
    const normalLeft = emitSelect(circuit, dragOwner[index]!, rectangleLeftNext[index]!, draggedLeft)
    const normalTop = emitSelect(circuit, dragOwner[index]!, rectangleTopNext[index]!, draggedTop)
    displayed.push(
      emitSelect(circuit, maximizedNext[index]!, normalLeft, zero),
      emitSelect(circuit, maximizedNext[index]!, normalTop, zero),
      emitSelect(
        circuit,
        maximizedNext[index]!,
        rectangleConstantCell(index, rectangleConstantField.width),
        sourceField.viewportWidth,
      ),
      emitSelect(
        circuit,
        maximizedNext[index]!,
        rectangleConstantCell(index, rectangleConstantField.height),
        sourceField.viewportHeight,
      ),
    )
  }

  // 11. Archived press records: on each down, the outgoing live record shifts
  // into the archive. The behavior above never reads these; they exist to
  // measure how the circuit cost scales with the latch window size, and they
  // are what a deeper consumer (double-click detection, flick velocity) would
  // read.
  const everPressed = clamp01(circuit.affine([[sourceField.everPressed, 1], [down, 1]]))
  const archiveNext: Wire[] = []
  for (let record = 0; record < pressRecordCount - 1; record++) {
    const incoming: Wire[] = record === 0
      ? [
          sourceField.everPressed,
          sourceField.pressX,
          sourceField.pressY,
          sourceField.pressRectangleStart,
          sourceField.pressRectangleStart + 1,
          sourceField.pressRectangleStart + 2,
          sourceField.pressRectangleStart + 3,
          sourceField.grabLeft,
          sourceField.grabTop,
          sourceField.pressOnTitle,
          sourceField.pressWasFocused,
          sourceField.pressOnMaximized,
        ]
      : Array.from({length: archiveField.size}, (_, field) => archiveCell(record - 1, field))
    for (let field = 0; field < archiveField.size; field++) {
      archiveNext.push(emitSelect(circuit, down, archiveCell(record, field), incoming[field]!))
    }
  }

  // Assemble the next source table.
  const nextSource = Array.from({length: size}, (_, field) => field)
  nextSource[sourceField.downActive] = zero
  nextSource[sourceField.moveActive] = zero
  nextSource[sourceField.upActive] = zero
  nextSource[sourceField.eventX] = zero
  nextSource[sourceField.eventY] = zero
  nextSource[sourceField.pointerX] = pointerX
  nextSource[sourceField.pointerY] = pointerY
  nextSource[sourceField.pressActive] = pressActive
  nextSource[sourceField.pressX] = pressX
  nextSource[sourceField.pressY] = pressY
  for (let index = 0; index < rectangleCount; index++) {
    nextSource[sourceField.pressRectangleStart + index] = pressRectangle[index]!
    nextSource[rectangleStateCell(index, rectangleStateField.left)] = rectangleLeftNext[index]!
    nextSource[rectangleStateCell(index, rectangleStateField.top)] = rectangleTopNext[index]!
    nextSource[rectangleStateCell(index, rectangleStateField.maximized)] = maximizedNext[index]!
    nextSource[rectangleStateCell(index, rectangleStateField.focused)] = focusedNext[index]!
  }
  nextSource[sourceField.grabLeft] = grabLeft
  nextSource[sourceField.grabTop] = grabTop
  nextSource[sourceField.pressOnTitle] = pressOnTitle
  nextSource[sourceField.pressWasFocused] = pressWasFocused
  nextSource[sourceField.pressOnMaximized] = pressOnMaximized
  nextSource[sourceField.slopLatch] = slopLatch
  nextSource[sourceField.everPressed] = everPressed
  for (let field = 0; field < archiveNext.length; field++) {
    nextSource[sourceField.archiveStart + field] = archiveNext[field]!
  }

  const wireCount = validateCircuit(circuit)
  validateWireView(nextSource, size, wireCount)
  validateWireView(displayed, rectangleCount * 4, wireCount)
  validateWireView(dragOwner, rectangleCount, wireCount)
  return {
    circuit,
    output: {nextSource, displayed, dragOwner},
    pressRecordCount,
  }
}

function declareSourceRanges(circuit: Circuit, pressRecordCount: number) {
  circuit.assumeRange(sourceField.unit, 1, 1)
  circuit.assumeRange(sourceField.viewportWidth, 0, coordinateBound)
  circuit.assumeRange(sourceField.viewportHeight, 0, coordinateBound)
  circuit.assumeRange(sourceField.slopBoundary, 0, 64)
  circuit.assumeRange(sourceField.titleBoundary, 0, 256)
  circuit.assumeRange(sourceField.dragFromTitle, 0, 1)
  circuit.assumeRange(sourceField.dragFromBody, 0, 1)
  circuit.assumeRange(sourceField.clickTogglesFromTitle, 0, 1)
  circuit.assumeRange(sourceField.clickTogglesFromBody, 0, 1)
  circuit.assumeRange(sourceField.thresholdSharpness, 0, 64)
  circuit.assumeRange(sourceField.downActive, 0, 1)
  circuit.assumeRange(sourceField.moveActive, 0, 1)
  circuit.assumeRange(sourceField.upActive, 0, 1)
  circuit.assumeRange(sourceField.eventX, -coordinateBound, coordinateBound)
  circuit.assumeRange(sourceField.eventY, -coordinateBound, coordinateBound)
  circuit.assumeRange(sourceField.pointerX, -coordinateBound, coordinateBound)
  circuit.assumeRange(sourceField.pointerY, -coordinateBound, coordinateBound)
  circuit.assumeRange(sourceField.pressActive, 0, 1)
  circuit.assumeRange(sourceField.pressX, -coordinateBound, coordinateBound)
  circuit.assumeRange(sourceField.pressY, -coordinateBound, coordinateBound)
  for (let index = 0; index < rectangleCount; index++) {
    circuit.assumeRange(sourceField.pressRectangleStart + index, 0, 1)
    circuit.assumeRange(rectangleConstantCell(index, rectangleConstantField.width), 1, coordinateBound)
    circuit.assumeRange(rectangleConstantCell(index, rectangleConstantField.height), 1, coordinateBound)
    circuit.assumeRange(rectangleStateCell(index, rectangleStateField.left), 0, coordinateBound)
    circuit.assumeRange(rectangleStateCell(index, rectangleStateField.top), 0, coordinateBound)
    circuit.assumeRange(rectangleStateCell(index, rectangleStateField.maximized), 0, 1)
    circuit.assumeRange(rectangleStateCell(index, rectangleStateField.focused), 0, 1)
  }
  circuit.assumeRange(sourceField.grabLeft, 0, coordinateBound)
  circuit.assumeRange(sourceField.grabTop, 0, coordinateBound)
  circuit.assumeRange(sourceField.pressOnTitle, 0, 1)
  circuit.assumeRange(sourceField.pressWasFocused, 0, 1)
  circuit.assumeRange(sourceField.pressOnMaximized, 0, 1)
  circuit.assumeRange(sourceField.slopLatch, 0, 1)
  circuit.assumeRange(sourceField.everPressed, 0, 1)
  for (let record = 0; record < pressRecordCount - 1; record++) {
    circuit.assumeRange(archiveCell(record, archiveField.present), 0, 1)
    circuit.assumeRange(archiveCell(record, archiveField.x), -coordinateBound, coordinateBound)
    circuit.assumeRange(archiveCell(record, archiveField.y), -coordinateBound, coordinateBound)
    for (let index = 0; index < rectangleCount; index++) {
      circuit.assumeRange(archiveCell(record, archiveField.rectangleStart + index), 0, 1)
    }
    circuit.assumeRange(archiveCell(record, archiveField.grabLeft), 0, coordinateBound)
    circuit.assumeRange(archiveCell(record, archiveField.grabTop), 0, coordinateBound)
    circuit.assumeRange(archiveCell(record, archiveField.onTitle), 0, 1)
    circuit.assumeRange(archiveCell(record, archiveField.wasFocused), 0, 1)
    circuit.assumeRange(archiveCell(record, archiveField.onMaximized), 0, 1)
  }
}

function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire) {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(
    circuit,
    circuit.affine([[position, 1], [start, -1]]),
    circuit.affine([[end, 1], [position, -1]]),
  )
}

function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

function emitClampDynamic(circuit: Circuit, value: Wire, minimum: Wire, maximum: Wire) {
  return emitMinimum(circuit, emitMaximum(circuit, value, minimum), maximum)
}

function emitAbsolute(circuit: Circuit, value: Wire) {
  const result = circuit.affine([
    [emitRelu(circuit, value), 1],
    [emitRelu(circuit, circuit.affine([[value, -1]])), 1],
  ])
  circuit.assumeRange(result, 0, Number.POSITIVE_INFINITY)
  return result
}

// The oracle's integer thresholds map to circuit boundary cells sitting at the
// center of the correct integer band: slop 4 means "distance 5 cancels the
// click", so the boundary lands at 4.5; titleHeight 30 means "relative y 29 is
// still title", so the boundary lands at 29.5.
export type BehaviorParameterValues = {
  slopBoundary: number
  titleBoundary: number
  dragFromTitle: number
  dragFromBody: number
  clickTogglesFromTitle: number
  clickTogglesFromBody: number
}

export const behaviorParameterCells = [
  sourceField.slopBoundary,
  sourceField.titleBoundary,
  sourceField.dragFromTitle,
  sourceField.dragFromBody,
  sourceField.clickTogglesFromTitle,
  sourceField.clickTogglesFromBody,
] as const

export function authoredParameterValues(config: BehaviorConfig): BehaviorParameterValues {
  return {
    slopBoundary: config.slop + 0.5,
    titleBoundary: config.titleHeight - 0.5,
    dragFromTitle: config.relations.dragFromTitle ? 1 : 0,
    dragFromBody: config.relations.dragFromBody ? 1 : 0,
    clickTogglesFromTitle: config.relations.clickTogglesFromTitle ? 1 : 0,
    clickTogglesFromBody: config.relations.clickTogglesFromBody ? 1 : 0,
  }
}

export function writeParameterValues(source: Float32Array, values: BehaviorParameterValues) {
  source[sourceField.slopBoundary] = values.slopBoundary
  source[sourceField.titleBoundary] = values.titleBoundary
  source[sourceField.dragFromTitle] = values.dragFromTitle
  source[sourceField.dragFromBody] = values.dragFromBody
  source[sourceField.clickTogglesFromTitle] = values.clickTogglesFromTitle
  source[sourceField.clickTogglesFromBody] = values.clickTogglesFromBody
}

export function writeConfigConstants(source: Float32Array, config: BehaviorConfig) {
  source[sourceField.unit] = 1
  source[sourceField.viewportWidth] = config.viewportWidth
  source[sourceField.viewportHeight] = config.viewportHeight
  source[sourceField.thresholdSharpness] = 1
  for (let index = 0; index < rectangleCount; index++) {
    const rectangle = config.rectangles[index]!
    source[rectangleConstantCell(index, rectangleConstantField.width)] = rectangle.width
    source[rectangleConstantCell(index, rectangleConstantField.height)] = rectangle.height
  }
}

// Fills the state cells (pointer, press record, slop latch, rectangle state)
// from an oracle state. Archive cells and everPressed are left untouched: the
// oracle does not model them and the behavior never reads them.
export function writeOracleStateToSource(state: OracleState, source: Float32Array) {
  source[sourceField.pointerX] = state.pointerX
  source[sourceField.pointerY] = state.pointerY
  source[sourceField.pressActive] = state.pressed ? 1 : 0
  source[sourceField.pressX] = state.pressX
  source[sourceField.pressY] = state.pressY
  for (let index = 0; index < rectangleCount; index++) {
    source[sourceField.pressRectangleStart + index] = state.pressedRectangle === index ? 1 : 0
    source[rectangleStateCell(index, rectangleStateField.left)] = state.rectangleLeft[index]!
    source[rectangleStateCell(index, rectangleStateField.top)] = state.rectangleTop[index]!
    source[rectangleStateCell(index, rectangleStateField.maximized)] = state.maximized[index]! ? 1 : 0
    source[rectangleStateCell(index, rectangleStateField.focused)] = state.focused === index ? 1 : 0
  }
  source[sourceField.grabLeft] = state.grabLeft
  source[sourceField.grabTop] = state.grabTop
  source[sourceField.pressOnTitle] = state.pressOnTitle ? 1 : 0
  source[sourceField.pressWasFocused] = state.pressWasFocused ? 1 : 0
  source[sourceField.pressOnMaximized] = state.pressOnMaximized ? 1 : 0
  source[sourceField.slopLatch] = state.pressed && state.slopExceeded ? 1 : 0
}

export function writeFrameInputToSource(input: FrameInput, source: Float32Array) {
  source[sourceField.downActive] = input?.kind === 'down' ? 1 : 0
  source[sourceField.moveActive] = input?.kind === 'move' ? 1 : 0
  source[sourceField.upActive] = input?.kind === 'up' ? 1 : 0
  source[sourceField.eventX] = input?.x ?? 0
  source[sourceField.eventY] = input?.y ?? 0
}

export type MachineFrame = {
  values: Float32Array
  displayed: Geometry[]
  dragOwner: number
  focused: number
  maximized: boolean[]
}

export type EventWindowMachine = {
  circuit: Circuit
  output: EventWindowOutput
  source: Float32Array
  step: (input: FrameInput) => MachineFrame
}

export function createEventWindowMachine(
  config: BehaviorConfig,
  options: {
    pressRecordCount?: number
    evaluator?: 'tensor' | 'reference'
    parameters?: BehaviorParameterValues
  } = {},
): EventWindowMachine {
  const evaluator = options.evaluator ?? 'tensor'
  const {circuit, output} = buildEventWindowCircuit('exact', options.pressRecordCount ?? 1)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    ...output.displayed,
    ...output.dragOwner,
  ])
  validateTensorProgram(circuit, tensorProgram)

  const source = new Float32Array(circuit.sourceSize)
  writeConfigConstants(source, config)
  writeParameterValues(source, options.parameters ?? authoredParameterValues(config))
  for (let index = 0; index < rectangleCount; index++) {
    const rectangle = config.rectangles[index]!
    source[rectangleStateCell(index, rectangleStateField.left)] = rectangle.initialLeft
    source[rectangleStateCell(index, rectangleStateField.top)] = rectangle.initialTop
  }

  function step(input: FrameInput): MachineFrame {
    writeFrameInputToSource(input, source)
    const values = evaluator === 'tensor'
      ? circuit.evaluateTensor(source)
      : circuit.evaluateReference(source)
    for (let field = 0; field < source.length; field++) {
      source[field] = values[output.nextSource[field]!]!
    }
    return {
      values,
      displayed: readDisplayedGeometry(values, output),
      dragOwner: readExactOneHot(values, output.dragOwner, 'drag owner'),
      focused: readExactOneHot(
        values,
        Array.from({length: rectangleCount}, (_, index) =>
          output.nextSource[rectangleStateCell(index, rectangleStateField.focused)]!),
        'focus',
      ),
      maximized: Array.from({length: rectangleCount}, (_, index) =>
        values[output.nextSource[rectangleStateCell(index, rectangleStateField.maximized)]!] === 1),
    }
  }

  return {circuit, output, source, step}
}

export function readDisplayedGeometry(values: Float32Array, output: EventWindowOutput): Geometry[] {
  return Array.from({length: rectangleCount}, (_, index) => ({
    left: values[output.displayed[index * 4]!]!,
    top: values[output.displayed[index * 4 + 1]!]!,
    width: values[output.displayed[index * 4 + 2]!]!,
    height: values[output.displayed[index * 4 + 3]!]!,
  }))
}

// Reads a one-hot group of exact bits back into an index, -1 when all zero.
// Anything that is not exactly 0 or 1, or more than one 1, is an error: the
// hardened circuit must never produce it.
function readExactOneHot(values: Float32Array, wires: readonly Wire[], label: string): number {
  let found = -1
  for (let index = 0; index < wires.length; index++) {
    const value = values[wires[index]!]!
    invariant(value === 0 || value === 1, `${label} bit ${index} is not an exact bit: ${value}`)
    if (value === 1) {
      invariant(found === -1, `${label} has more than one active bit`)
      found = index
    }
  }
  return found
}
