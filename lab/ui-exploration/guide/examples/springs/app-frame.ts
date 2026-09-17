// Level 3 of three: one frame of a small app, written as a builder the way
// index.ts writes render(). A list of 12 rows with a highlight behind the
// selected row. ArrowDown and ArrowUp move the selection, and holding the
// pointer down shrinks the highlight a little. The highlight's top and scale are
// two springs with different stiffness and damping. One clock counts this
// frame's 4 ms steps, and both springs step by its binary digits.
import {Circuit, type Wire, asWire, emitMaximum, emitMinimum} from '../../../../../src/runtime/numeric-ui-core.ts'
import {type Spring, seededRandom, spring, springStillAnimating, stepSpringTo} from './frame-rate-check.ts'
import {emitStepSpringTo} from './spring-catch-up.ts'
import {type ClockCells, declareClockRanges, emitSpringClock, maxCarriedMs, maxSteps, timeGrid} from './spring-clock.ts'
import {stepMs} from './spring-step.ts'

export const rowCount = 12
export const rowHeight = 44
export const topConstants = {stiffness: 290, damping: 30}
export const scaleConstants = {stiffness: 333, damping: 20}
export const pressedScale = 0.97

// The source table. Every value kept until the next frame is stored in a
// cell; the builder functions keep no state of their own.
export const cell = {
  // Written by JS every frame.
  frameDeltaMs: asWire(0),
  arrowDown: asWire(1),
  arrowUp: asWire(2),
  pointerHeld: asWire(3),
  // State, written back from the next-state outputs.
  leftoverMs: asWire(4),
  running: asWire(5),
  selectedIndex: asWire(6),
  topPosition: asWire(7),
  topVelocity: asWire(8),
  scalePosition: asWire(9),
  scaleVelocity: asWire(10),
  size: 11,
} as const

const clockCells: ClockCells = {frameDeltaMs: cell.frameDeltaMs, leftoverMs: cell.leftoverMs, running: cell.running}

export function buildHighlightFrame(circuit: Circuit) {
  // Declare every cell's range before any operation reads the cell.
  declareClockRanges(circuit, clockCells)
  circuit.assumeRange(cell.arrowDown, 0, 1)
  circuit.assumeRange(cell.arrowUp, 0, 1)
  circuit.assumeRange(cell.pointerHeld, 0, 1)
  circuit.assumeRange(cell.selectedIndex, 0, rowCount - 1)

  // Handle inputs
  const zero = circuit.affine([])
  const lastIndex = circuit.affine([], rowCount - 1)
  const movedIndex = circuit.roundAffine([[cell.selectedIndex, 1], [cell.arrowDown, 1], [cell.arrowUp, -1]])
  const selectedIndex = emitMinimum(circuit, emitMaximum(circuit, movedIndex, zero), lastIndex)

  // New layout
  const topDestination = circuit.roundAffine([[selectedIndex, rowHeight]])
  const scaleDestination = circuit.roundAffine([[cell.pointerHeld, pressedScale - 1]], 1)

  // Animation tick
  const clock = emitSpringClock(circuit, clockCells)
  const top = emitStepSpringTo(
    circuit,
    {position: cell.topPosition, velocity: cell.topVelocity},
    topDestination,
    clock.stepBits,
    topConstants,
  )
  const scale = emitStepSpringTo(
    circuit,
    {position: cell.scalePosition, velocity: cell.scaleVelocity},
    scaleDestination,
    clock.stepBits,
    scaleConstants,
  )
  const stillAnimating = emitMaximum(circuit, top.stillAnimating, scale.stillAnimating)

  // Commit state. Cells that JS writes every frame pass through unchanged.
  const nextSource: Wire[] = Array.from({length: cell.size}, (_, index) => circuit.source(index))
  nextSource[cell.leftoverMs] = clock.nextLeftoverMs
  nextSource[cell.running] = stillAnimating
  nextSource[cell.selectedIndex] = selectedIndex
  nextSource[cell.topPosition] = top.position
  nextSource[cell.topVelocity] = top.velocity
  nextSource[cell.scalePosition] = scale.position
  nextSource[cell.scaleVelocity] = scale.velocity

  return {
    nextSource,
    highlightTop: top.position,
    highlightScale: scale.position,
    stillAnimating,
    stepCount: clock.stepCount,
  }
}

export type HighlightInput = {arrowDown: boolean, arrowUp: boolean, pointerHeld: boolean}

// The JS host: writes inputs, evaluates, copies next state back.
export function createHighlightMachine() {
  const circuit = new Circuit(cell.size)
  const frame = buildHighlightFrame(circuit)
  const roots = [...frame.nextSource, frame.highlightTop, frame.highlightScale, frame.stillAnimating, frame.stepCount]
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(cell.size)
  source[cell.scalePosition] = 1
  let previousFrameTime: number | null = null
  return {
    circuit,
    roots,
    source,
    renderFrame(now: number, input: HighlightInput) {
      // Absolute timestamps stay in float64 here. An FP32 cell holding
      // performance.now() loses resolution as a session gets long.
      const quantizedNow = Math.round(now * timeGrid) / timeGrid
      source[cell.frameDeltaMs] = previousFrameTime === null
        ? 0
        : Math.min(maxCarriedMs, Math.max(0, quantizedNow - previousFrameTime))
      previousFrameTime = quantizedNow
      source[cell.arrowDown] = input.arrowDown ? 1 : 0
      source[cell.arrowUp] = input.arrowUp ? 1 : 0
      source[cell.pointerHeld] = input.pointerHeld ? 1 : 0
      const outputs = evaluate(source)
      const result = {
        highlightTop: outputs[cell.size]!,
        highlightScale: outputs[cell.size + 1]!,
        stillAnimating: outputs[cell.size + 2]!,
        stepCount: outputs[cell.size + 3]!,
      }
      for (let index = 0; index < cell.size; index++) source[index] = outputs[index]!
      return result
    },
  }
}

// Plain float64 reference: index.ts's render(), steps 2 to 4, for this app, with
// the 300-step cap from vibescript's ui.md.
export type ReferenceState = {
  animatedUntilTime: number | null
  selectedIndex: number
  top: Spring
  scale: Spring
}

export function initialReferenceState(): ReferenceState {
  return {
    animatedUntilTime: null,
    selectedIndex: 0,
    top: spring(0, 0, topConstants.stiffness, topConstants.damping),
    scale: spring(1, 0, scaleConstants.stiffness, scaleConstants.damping),
  }
}

export function referenceFrame(previous: ReferenceState, now: number, input: HighlightInput) {
  // Handle inputs
  const movedIndex = previous.selectedIndex + (input.arrowDown ? 1 : 0) - (input.arrowUp ? 1 : 0)
  const selectedIndex = Math.min(rowCount - 1, Math.max(0, movedIndex))
  // New layout
  const topDestination = selectedIndex * rowHeight
  const scaleDestination = input.pointerHeld ? pressedScale : 1
  // Run animation
  let newAnimatedUntilTime: number = previous.animatedUntilTime ?? now
  const steps = Math.min(maxSteps, Math.floor((now - newAnimatedUntilTime) / stepMs))
  newAnimatedUntilTime += steps * stepMs
  const top = stepSpringTo(previous.top, topDestination, steps)
  const scale = stepSpringTo(previous.scale, scaleDestination, steps)
  const stillAnimating = springStillAnimating(top) || springStillAnimating(scale)
  const state: ReferenceState = {
    animatedUntilTime: stillAnimating ? newAnimatedUntilTime : null,
    selectedIndex,
    top,
    scale,
  }
  return {state, steps, stillAnimating}
}

export type TraceFrame = {now: number, input: HighlightInput}

// Frame deltas mixing 120, 60 and 30 fps, irregular frames, 100 ms frames and
// stalls of 0.3 to 2.6 s, on a 1/64 ms grid. Arrow presses and pointer holds at
// random frames.
export function randomFrameTrace(seed: number, frameCount: number): TraceFrame[] {
  const random = seededRandom(seed)
  const frames: TraceFrame[] = []
  let now = 1000
  let pointerHeld = false
  for (let index = 0; index < frameCount; index++) {
    const pick = random()
    const deltaMs = pick < 0.35 ? 1000 / 120
      : pick < 0.65 ? 1000 / 60
      : pick < 0.8 ? 1000 / 30
      : pick < 0.9 ? 4 + random() * 40
      : pick < 0.96 ? 100
      : 300 + random() * 2300
    now = Math.round((now + deltaMs) * timeGrid) / timeGrid
    if (random() < 0.03) pointerHeld = !pointerHeld
    frames.push({now, input: {arrowDown: random() < 0.07, arrowUp: random() < 0.04, pointerHeld}})
  }
  return frames
}
