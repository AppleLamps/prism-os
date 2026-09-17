// Checks shared by springs.test.ts and report.ts: each circuit example against
// plain float64 JavaScript.
import {Circuit, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {
  type ReferenceState,
  cell,
  createHighlightMachine,
  initialReferenceState,
  randomFrameTrace,
  referenceFrame,
  scaleConstants,
  topConstants,
} from './app-frame.ts'
import {type CatchUpForm, buildCatchUp, digitCells, matrixCells, measureProgram, springCells, stepCountCell} from './costs.ts'
import {seededRandom, spring, springStillAnimating, stepSpringTo} from './frame-rate-check.ts'
import {emitSpringSteps, emitStepSpringTo, settleDistance, settleSpeed} from './spring-catch-up.ts'
import {declareClockRanges, emitSpringClock, maxCarriedMs, maxSteps, stepDigitCount} from './spring-clock.ts'
import {emitSpringStep, matrixPower, referenceSpringStep, springStepMatrix, stepMs} from './spring-step.ts'

// Level 1: one step, and 300 steps chained at build time.
export function checkSpringStep(sampleCount: number) {
  const circuit = new Circuit(2)
  const start = {displacement: circuit.source(0), velocity: circuit.source(1)}
  const oneStep = emitSpringStep(circuit, start, topConstants)
  let chained = start
  for (let step = 0; step < 300; step++) chained = emitSpringStep(circuit, chained, topConstants)
  const oneStepSize = measureProgram(circuit, [oneStep.displacement, oneStep.velocity])
  const chainedSize = measureProgram(circuit, [chained.displacement, chained.velocity])
  const evaluate = circuit.createTensorEvaluator([oneStep.displacement, oneStep.velocity, chained.displacement, chained.velocity])
  const random = seededRandom(11)
  let maxOneStepError = 0
  let maxChainedError = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const displacement = Math.fround((random() * 2 - 1) * 1000)
    const velocity = Math.fround((random() * 2 - 1) * 5000)
    const outputs = evaluate(Float32Array.of(displacement, velocity))
    const expected = referenceSpringStep(displacement, velocity, topConstants)
    maxOneStepError = Math.max(maxOneStepError, Math.abs(outputs[0]! - expected.displacement))
    let expectedDisplacement = displacement
    let expectedVelocity = velocity
    for (let step = 0; step < 300; step++) {
      const next = referenceSpringStep(expectedDisplacement, expectedVelocity, topConstants)
      expectedDisplacement = next.displacement
      expectedVelocity = next.velocity
    }
    maxChainedError = Math.max(maxChainedError, Math.abs(outputs[2]! - expectedDisplacement))
  }
  return {createdOperations: circuit.operations.length, oneStepSize, chainedSize, maxOneStepError, maxChainedError}
}

// float64 steps without index.ts's snap, to see how close a sample sits to the
// settle thresholds.
function stepsWithoutSnap(position: number, velocity: number, destination: number, steps: number) {
  const dt = stepMs / 1000
  let pos = position
  let v = velocity
  for (let step = 0; step < steps; step++) {
    v += (-topConstants.stiffness * (pos - destination) - topConstants.damping * v) * dt
    pos += v * dt
  }
  return {pos, v}
}

// Level 2: random springs, destinations and step counts, with JS writing the
// step count's binary digits into cells.
export function checkStepSpringTo(seed: number, sampleCount: number) {
  const circuit = new Circuit(3 + stepDigitCount)
  const stepBits = Array.from({length: stepDigitCount}, (_, digit) => 3 + digit)
  for (const bit of stepBits) circuit.assumeRange(asWire(bit), 0, 1)
  const stepped = emitStepSpringTo(circuit, {position: circuit.source(0), velocity: circuit.source(1)}, circuit.source(2), stepBits.map(asWire), topConstants)
  const roots = [stepped.position, stepped.velocity, stepped.stillAnimating]
  const evaluate = circuit.createTensorEvaluator(roots)
  const random = seededRandom(seed)
  const source = new Float32Array(circuit.sourceSize)
  let maxPositionError = 0
  let maxVelocityError = 0
  let settleMismatches = 0
  let settleMismatchesNearThreshold = 0
  let snappedSamples = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const nearRest = random() < 0.3
    const destination = Math.round(random() * 600)
    const position = Math.fround(nearRest ? destination + (random() * 2 - 1) * 0.3 : random() * 1000 - 200)
    const velocity = Math.fround(nearRest ? (random() * 2 - 1) * 3 : (random() * 2 - 1) * 4000)
    const steps = random() < 0.2 ? Math.floor(random() * 4) : Math.floor(random() * (maxSteps + 1))
    source[0] = position
    source[1] = velocity
    source[2] = destination
    for (let digit = 0; digit < stepDigitCount; digit++) source[3 + digit] = (steps >> digit) & 1
    const outputs = evaluate(source)
    const previous = {...spring(position, velocity, topConstants.stiffness, topConstants.damping), dest: destination}
    const expected = stepSpringTo(previous, destination, steps)
    const expectedStillAnimating = springStillAnimating(expected)
    if (!expectedStillAnimating) snappedSamples++
    if ((outputs[2] === 1) !== expectedStillAnimating) {
      settleMismatches++
      const unsnapped = stepsWithoutSnap(position, velocity, destination, steps)
      const margin = Math.min(
        Math.abs(Math.abs(unsnapped.pos - destination) - settleDistance),
        Math.abs(Math.abs(unsnapped.v) - settleSpeed),
      )
      if (margin < 1e-4) settleMismatchesNearThreshold++
      continue
    }
    maxPositionError = Math.max(maxPositionError, Math.abs(outputs[0]! - expected.pos))
    maxVelocityError = Math.max(maxVelocityError, Math.abs(outputs[1]! - expected.v))
  }
  return {
    size: measureProgram(circuit, roots),
    samples: sampleCount,
    maxPositionError,
    maxVelocityError,
    settleMismatches,
    settleMismatchesNearThreshold,
    snappedSamples,
  }
}

// goToEnd: the spring lands on its destination with zero velocity and stops
// animating, whatever the step count.
export function checkGoToEnd(seed: number, sampleCount: number) {
  const goToEndCell = 3 + stepDigitCount
  const circuit = new Circuit(4 + stepDigitCount)
  const stepBits = Array.from({length: stepDigitCount}, (_, digit) => 3 + digit)
  for (const bit of stepBits) circuit.assumeRange(asWire(bit), 0, 1)
  circuit.assumeRange(asWire(goToEndCell), 0, 1)
  const stepped = emitStepSpringTo(circuit, {position: circuit.source(0), velocity: circuit.source(1)}, circuit.source(2), stepBits.map(asWire), topConstants, asWire(goToEndCell))
  const evaluate = circuit.createTensorEvaluator([stepped.position, stepped.velocity, stepped.stillAnimating])
  const random = seededRandom(seed)
  const source = new Float32Array(circuit.sourceSize)
  let mismatches = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const destination = Math.round(random() * 600)
    const position = Math.fround(random() * 1000 - 200)
    const velocity = Math.fround((random() * 2 - 1) * 4000)
    const steps = Math.floor(random() * (maxSteps + 1))
    const goToEnd = random() < 0.5
    source[0] = position
    source[1] = velocity
    source[2] = destination
    for (let digit = 0; digit < stepDigitCount; digit++) source[3 + digit] = (steps >> digit) & 1
    source[goToEndCell] = goToEnd ? 1 : 0
    const outputs = evaluate(source)
    if (goToEnd) {
      if (outputs[0] !== destination || outputs[1] !== 0 || outputs[2] !== 0) mismatches++
    } else {
      const previous = {...spring(position, velocity, topConstants.stiffness, topConstants.damping), dest: destination}
      const expected = stepSpringTo(previous, destination, steps)
      if ((outputs[2] === 1) !== springStillAnimating(expected) || Math.abs(outputs[0]! - expected.pos) > 1e-3) mismatches++
    }
  }
  return {samples: sampleCount, mismatches}
}

// The clock: min(300, floor(pending / 4)) steps and the carried leftover.
export function checkClock(seed: number) {
  const circuit = new Circuit(3)
  const cells = {frameDeltaMs: circuit.source(0), leftoverMs: circuit.source(1), running: circuit.source(2)}
  declareClockRanges(circuit, cells)
  const clock = emitSpringClock(circuit, cells)
  const roots = [clock.stepCount, clock.nextLeftoverMs]
  const evaluate = circuit.createTensorEvaluator(roots)
  const random = seededRandom(seed)
  const onGrid = (value: number) => Math.round(value * 64) / 64
  const pendingValues: number[] = []
  for (let steps = 0; steps <= 305; steps++) {
    for (const offset of [-1 / 64, 0, 1 / 64]) if (4 * steps + offset >= 0) pendingValues.push(4 * steps + offset)
  }
  for (let sample = 0; sample < 1000; sample++) pendingValues.push(onGrid(random() * 2 * maxCarriedMs))
  let checked = 0
  let mismatches = 0
  for (const pending of pendingValues) {
    const lower = Math.max(0, pending - maxCarriedMs)
    const upper = Math.min(pending, maxCarriedMs)
    const leftover = onGrid(lower + (upper - lower) * random())
    const delta = pending - leftover
    for (const running of [0, 1]) {
      const outputs = evaluate(Float32Array.of(delta, leftover, running))
      const expectedPending = running === 1 ? pending : 0
      const expectedSteps = Math.min(maxSteps, Math.floor(expectedPending / stepMs))
      const expectedLeftover = Math.min(maxCarriedMs, expectedPending - expectedSteps * stepMs)
      checked++
      if (outputs[0] !== expectedSteps || outputs[1] !== expectedLeftover) mismatches++
    }
  }
  return {size: measureProgram(circuit, roots), checked, mismatches}
}

// The clock followed by one spring's steps, with the digits applied in each order.
export function measureDigitOrderDepth() {
  const build = (digitOrder: 'most significant first' | 'least significant first') => {
    const circuit = new Circuit(5)
    const cells = {frameDeltaMs: circuit.source(0), leftoverMs: circuit.source(1), running: circuit.source(2)}
    declareClockRanges(circuit, cells)
    const clock = emitSpringClock(circuit, cells)
    const stepped = emitSpringSteps(circuit, {displacement: circuit.source(3), velocity: circuit.source(4)}, clock.stepBits, topConstants, digitOrder)
    return measureProgram(circuit, [stepped.displacement, stepped.velocity])
  }
  return {mostSignificantFirst: build('most significant first'), leastSignificantFirst: build('least significant first')}
}

// Level 3, one frame at a time: before every frame, the float64 reference starts
// from the circuit's own state, so the comparison measures one frame's error.
export function checkAppRestartedEveryFrame(seed: number, frameCount: number) {
  const machine = createHighlightMachine()
  const trace = randomFrameTrace(seed, frameCount)
  let previousNow: number | null = null
  let maxPositionError = 0
  let maxVelocityError = 0
  let stepCountMismatches = 0
  let leftoverMismatches = 0
  let selectionMismatches = 0
  let settleMismatches = 0
  let animatingFrames = 0
  let cappedFrames = 0
  for (const frame of trace) {
    const source = machine.source
    const restarted: ReferenceState = {
      animatedUntilTime: source[cell.running] === 1 && previousNow !== null ? previousNow - source[cell.leftoverMs]! : null,
      selectedIndex: source[cell.selectedIndex]!,
      top: spring(source[cell.topPosition]!, source[cell.topVelocity]!, topConstants.stiffness, topConstants.damping),
      scale: spring(source[cell.scalePosition]!, source[cell.scaleVelocity]!, scaleConstants.stiffness, scaleConstants.damping),
    }
    const expected = referenceFrame(restarted, frame.now, frame.input)
    const actual = machine.renderFrame(frame.now, frame.input)
    previousNow = frame.now
    if (actual.stepCount !== expected.steps) stepCountMismatches++
    if (expected.steps === maxSteps) cappedFrames++
    if (machine.source[cell.selectedIndex] !== expected.state.selectedIndex) selectionMismatches++
    if ((actual.stillAnimating === 1) !== expected.stillAnimating) {
      settleMismatches++
      continue
    }
    if (expected.stillAnimating) {
      animatingFrames++
      if (machine.source[cell.leftoverMs] !== frame.now - expected.state.animatedUntilTime!) leftoverMismatches++
    }
    maxPositionError = Math.max(
      maxPositionError,
      Math.abs(machine.source[cell.topPosition]! - expected.state.top.pos),
      Math.abs(machine.source[cell.scalePosition]! - expected.state.scale.pos),
    )
    maxVelocityError = Math.max(
      maxVelocityError,
      Math.abs(machine.source[cell.topVelocity]! - expected.state.top.v),
      Math.abs(machine.source[cell.scaleVelocity]! - expected.state.scale.v),
    )
  }
  return {
    frames: frameCount,
    animatingFrames,
    cappedFrames,
    maxPositionError,
    maxVelocityError,
    stepCountMismatches,
    leftoverMismatches,
    selectionMismatches,
    settleMismatches,
  }
}

// Level 3, free-running: the circuit and the float64 reference each carry their
// own state over the whole trace.
export function checkAppFreeRunning(seed: number, frameCount: number) {
  const machine = createHighlightMachine()
  const trace = randomFrameTrace(seed, frameCount)
  let reference = initialReferenceState()
  let maxPositionErrorWhileBothAnimate = 0
  let maxPositionError = 0
  let settleMismatchFrames = 0
  let stepCountMismatchFrames = 0
  for (const frame of trace) {
    const expected = referenceFrame(reference, frame.now, frame.input)
    reference = expected.state
    const actual = machine.renderFrame(frame.now, frame.input)
    const error = Math.max(
      Math.abs(actual.highlightTop - expected.state.top.pos),
      Math.abs(actual.highlightScale - expected.state.scale.pos),
    )
    maxPositionError = Math.max(maxPositionError, error)
    if (actual.stepCount !== expected.steps) stepCountMismatchFrames++
    if ((actual.stillAnimating === 1) !== expected.stillAnimating) settleMismatchFrames++
    else if (expected.stillAnimating) maxPositionErrorWhileBothAnimate = Math.max(maxPositionErrorWhileBothAnimate, error)
  }
  return {frames: frameCount, maxPositionErrorWhileBothAnimate, maxPositionError, settleMismatchFrames, stepCountMismatchFrames}
}

// Every catch-up form against a float64 loop, one spring.
export function checkCatchUpForm(form: CatchUpForm, seed: number, sampleCount: number) {
  const {circuit, roots} = buildCatchUp(form, 1, topConstants)
  const evaluate = circuit.createTensorEvaluator(roots)
  const random = seededRandom(seed)
  const cellsOfSpring = springCells(0)
  const stepDigitCells = digitCells(1)
  const source = new Float32Array(circuit.sourceSize)
  const step = springStepMatrix(topConstants)
  let maxDisplacementError = 0
  let maxVelocityError = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const steps = Math.floor(random() * (maxSteps + 1))
    const displacement = Math.fround((random() * 2 - 1) * 1000)
    const velocity = Math.fround((random() * 2 - 1) * 4000)
    // Every form's cells are written; each form reads only its own.
    source[stepCountCell] = steps
    for (let digit = 0; digit < stepDigitCells.length; digit++) source[stepDigitCells[digit]!] = (steps >> digit) & 1
    const frameMatrix = matrixPower(step, steps)
    for (let entry = 0; entry < 4; entry++) source[matrixCells[entry]!] = frameMatrix[entry]!
    source[cellsOfSpring.displacement] = displacement
    source[cellsOfSpring.velocity] = velocity
    const outputs = evaluate(source)
    let expectedDisplacement = displacement
    let expectedVelocity = velocity
    for (let index = 0; index < steps; index++) {
      const next = referenceSpringStep(expectedDisplacement, expectedVelocity, topConstants)
      expectedDisplacement = next.displacement
      expectedVelocity = next.velocity
    }
    maxDisplacementError = Math.max(maxDisplacementError, Math.abs(outputs[0]! - expectedDisplacement))
    maxVelocityError = Math.max(maxVelocityError, Math.abs(outputs[1]! - expectedVelocity))
  }
  return {maxDisplacementError, maxVelocityError}
}
