// The settle snap on top of spring-power.ts: when the stepped spring is within
// 0.01 px and 0.01 px/s, select the destination and zero velocity on an exact bit,
// the way spring-bank's boxes do. The circuit also has a second output that makes
// the same selection on a copy of the settle bit held in a cell, so the backward
// pass treats the decision as data, i.e. gradient 0 through the decision.
import {Circuit, emitSelect, asWire} from '../../../../../numeric-ui-core.ts'
import {
  type ParameterName,
  type SpringParameters,
  buildSpringPowerCircuit,
  centralDifference,
  createRandom,
  declareSpringRanges,
  emitApplyFrameMatrix,
  emitMatrixPower,
  emitStepMatrix,
  parameterNames,
  randomSpringParameters,
  referenceSpringPower,
  springCells,
  springSourceSize,
  withParameter,
  writeSpringSource,
} from './spring-power.ts'

export const settleDistance = 0.01
export const settleSpeed = 0.01
const settledAsDataCell = springSourceSize

export function buildSnappedSpringCircuit() {
  const circuit = new Circuit(springSourceSize + 1)
  declareSpringRanges(circuit, springCells)
  circuit.assumeRange(asWire(settledAsDataCell), 0, 1)
  const frame = emitMatrixPower(circuit, emitStepMatrix(circuit, springCells), springCells.stepBits)
  const stepped = emitApplyFrameMatrix(circuit, frame, springCells)
  // Each ReLU is exactly 0 when its side is within the threshold, and a sum of
  // nonnegative FP32 values is 0 only when every term is 0.
  const exceedance = circuit.roundAffine([
    [circuit.reglu([], 1, [[stepped.displacement, 1]], -settleDistance), 1],
    [circuit.reglu([], 1, [[stepped.displacement, -1]], -settleDistance), 1],
    [circuit.reglu([], 1, [[stepped.velocity, 1]], -settleSpeed), 1],
    [circuit.reglu([], 1, [[stepped.velocity, -1]], -settleSpeed), 1],
  ])
  const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
  circuit.assumeRange(settledScore, 0, 1)
  const settled = circuit.boolean(settledScore)
  const zero = circuit.affine([], 0)
  const position = emitSelect(circuit, settled, stepped.position, springCells.destination)
  const velocity = emitSelect(circuit, settled, stepped.velocity, zero)
  const positionWithDecisionAsData = emitSelect(circuit, asWire(settledAsDataCell), stepped.position, springCells.destination)
  return {circuit, cells: springCells, settledAsDataCell, stepped, exceedance, settled, position, velocity, positionWithDecisionAsData}
}

type SnappedCircuit = ReturnType<typeof buildSnappedSpringCircuit>

export function referenceSnappedSpring(parameters: SpringParameters, stepCount: number) {
  const stepped = referenceSpringPower(parameters, stepCount)
  const threshold = Math.fround(settleDistance)
  const settled = Math.abs(stepped.displacement) <= threshold && Math.abs(stepped.velocity) <= threshold
  return settled
    ? {position: parameters.destination, velocity: 0, settled}
    : {position: stepped.position, velocity: stepped.velocity, settled}
}

function evaluateSnapped(built: SnappedCircuit, parameters: SpringParameters, stepCount: number) {
  const source = new Float32Array(built.circuit.sourceSize)
  writeSpringSource(source, built.cells, parameters, stepCount)
  const firstValues = built.circuit.evaluateReference(source)
  source[built.settledAsDataCell] = firstValues[built.settled]!
  return built.circuit.evaluateReference(source)
}

function seedsFor(length: number, wire: number) {
  const seeds = new Float32Array(length)
  seeds[wire] = 1
  return seeds
}

export type SnapCheck = {
  samples: number
  snapped: number
  notSnapped: number
  // Samples where the float64 twin's settle decision differs, skipped from the comparison.
  settleDecisionDifferences: number
  // Snapped samples: the gradient should be 1 on the destination and 0 elsewhere.
  snappedGradientMismatches: number
  // Not snapped: the gradient should equal the stepped spring's gradient.
  notSnappedGradientMismatches: number
  // (sample, parameter) pairs compared with a central difference, and pairs skipped
  // because the twin's settle decision flips within the difference's step.
  finiteDifferencePairs: number
  finiteDifferencePairsAcrossTheSnap: number
  largestFiniteDifferenceError: number
  // Samples where straight-through through the boolean atom gives a different gradient
  // from the decision as data.
  straightThroughDifferences: number
  defaultOptionsMessage: string
}

// |backward - difference| / max(|difference|, 1e-3).
export function gradientError(backwardValue: number, finiteDifference: number) {
  return Math.abs(backwardValue - finiteDifference) / Math.max(Math.abs(finiteDifference), 1e-3)
}

export function checkSettleSnap(stepCounts: readonly number[] = [4, 16, 64, 150, 300], samplesPerCount = 40, seed = 11): SnapCheck {
  const built = buildSnappedSpringCircuit()
  const plain = buildSpringPowerCircuit()
  const random = createRandom(seed)
  const result: SnapCheck = {
    samples: 0, snapped: 0, notSnapped: 0, settleDecisionDifferences: 0, snappedGradientMismatches: 0,
    notSnappedGradientMismatches: 0, finiteDifferencePairs: 0, finiteDifferencePairsAcrossTheSnap: 0,
    largestFiniteDifferenceError: 0, straightThroughDifferences: 0, defaultOptionsMessage: '',
  }
  for (const stepCount of stepCounts) {
    for (let sample = 0; sample < samplesPerCount; sample++) {
      const parameters = randomSpringParameters(random)
      const values = evaluateSnapped(built, parameters, stepCount)
      const settled = values[built.settled] === 1
      result.samples++
      if (settled !== referenceSnappedSpring(parameters, stepCount).settled) {
        result.settleDecisionDifferences++
        continue
      }
      const asData = built.circuit.backpropagateReference(values, seedsFor(values.length, built.positionWithDecisionAsData))
      const straightThrough = built.circuit.backpropagateReference(values, seedsFor(values.length, built.position), {booleanGradient: 'straight-through'})
      if (parameterNames.some(name => asData[built.cells[name]] !== straightThrough[built.cells[name]])) result.straightThroughDifferences++
      if (result.defaultOptionsMessage === '' && values[built.stepped.position] !== values[built.cells.destination]) {
        try {
          built.circuit.backpropagateReference(values, seedsFor(values.length, built.position))
        } catch (error) {
          result.defaultOptionsMessage = (error as Error).message
        }
      }
      if (settled) {
        result.snapped++
        const expected = (name: ParameterName) => (name === 'destination' ? 1 : 0)
        if (parameterNames.some(name => asData[built.cells[name]] !== expected(name))) result.snappedGradientMismatches++
      } else {
        result.notSnapped++
        const plainSource = new Float32Array(plain.circuit.sourceSize)
        writeSpringSource(plainSource, plain.cells, parameters, stepCount)
        const plainValues = plain.circuit.evaluateReference(plainSource)
        const plainGradients = plain.circuit.backpropagateReference(plainValues, seedsFor(plainValues.length, plain.stepped.position))
        if (parameterNames.some(name => asData[built.cells[name]] !== plainGradients[plain.cells[name]])) result.notSnappedGradientMismatches++
      }
      for (const name of parameterNames) {
        const step = 1e-6 * Math.max(1, Math.abs(parameters[name]))
        const below = referenceSnappedSpring(withParameter(parameters, name, parameters[name] - step), stepCount)
        const above = referenceSnappedSpring(withParameter(parameters, name, parameters[name] + step), stepCount)
        if (below.settled !== settled || above.settled !== settled) {
          result.finiteDifferencePairsAcrossTheSnap++
          continue
        }
        result.finiteDifferencePairs++
        const finiteDifference = (above.position - below.position) / (2 * step)
        result.largestFiniteDifferenceError = Math.max(result.largestFiniteDifferenceError, gradientError(asData[built.cells[name]]!, finiteDifference))
      }
    }
  }
  return result
}

export type SnapBoundary = {
  stepCount: number
  stiffnessBelow: number
  stiffnessAbove: number
  settledBelow: number
  settledAbove: number
  positionBelow: number
  positionAbove: number
  // (positionAbove - positionBelow) / (stiffnessAbove - stiffnessBelow), from the circuit.
  finiteDifferenceAcrossTheSnap: number
  gradientBelow: number
  gradientAbove: number
}

// Scans stiffness for a flip of the circuit's settle bit, then bisects between two
// FP32 stiffness values until they're next to each other, and compares the jump
// with what the backward pass reports on each side.
export function findSnapBoundary(stepCount = 150): SnapBoundary {
  const built = buildSnappedSpringCircuit()
  const base: SpringParameters = {stiffness: 290, damping: 30, stepSeconds: 0.004, destination: 100, position: 0, velocity: 0}
  const settledAt = (stiffness: number) => evaluateSnapped(built, withParameter(base, 'stiffness', stiffness), stepCount)[built.settled]!
  let low = 100
  let high = low
  for (let stiffness = 101; stiffness <= 700; stiffness++) {
    if (settledAt(stiffness) !== settledAt(low)) {
      high = stiffness
      break
    }
    low = stiffness
  }
  if (high === low) throw new Error('no settle flip found')
  const lowBit = settledAt(low)
  for (let round = 0; round < 60; round++) {
    const middle = Math.fround((low + high) / 2)
    if (middle === low || middle === high) break
    if (settledAt(middle) === lowBit) low = middle
    else high = middle
  }
  const gradientAt = (stiffness: number) => {
    const values = evaluateSnapped(built, withParameter(base, 'stiffness', stiffness), stepCount)
    const gradients = built.circuit.backpropagateReference(values, seedsFor(values.length, built.positionWithDecisionAsData))
    return {values, stiffnessGradient: gradients[built.cells.stiffness]!}
  }
  const below = gradientAt(low)
  const above = gradientAt(high)
  return {
    stepCount,
    stiffnessBelow: low,
    stiffnessAbove: high,
    settledBelow: below.values[built.settled]!,
    settledAbove: above.values[built.settled]!,
    positionBelow: below.values[built.position]!,
    positionAbove: above.values[built.position]!,
    finiteDifferenceAcrossTheSnap: (above.values[built.position]! - below.values[built.position]!) / (high - low),
    gradientBelow: below.stiffnessGradient,
    gradientAbove: above.stiffnessGradient,
  }
}

export type SettlingRow = {
  stepCount: number
  displacement: number
  stiffnessGradient: number
  stiffnessFiniteDifference: number
  destinationGradient: number
  destinationFiniteDifference: number
  initialPositionGradient: number
  initialPositionFiniteDifference: number
}

// The stepped spring without the snap, for more and more steps. Implicit
// differentiation of the settled state (displacement 0, velocity 0) says the settled
// position is the destination, so its gradient is 0 for stiffness and initial
// position, and 1 for the destination.
export function settlingGradients(stepCounts: readonly number[] = [4, 16, 64, 150, 300]): SettlingRow[] {
  const {circuit, cells, stepped} = buildSpringPowerCircuit()
  const parameters: SpringParameters = {stiffness: 290, damping: 30, stepSeconds: 0.004, destination: 100, position: 0, velocity: 0}
  return stepCounts.map(stepCount => {
    const source = new Float32Array(circuit.sourceSize)
    writeSpringSource(source, cells, parameters, stepCount)
    const values = circuit.evaluateReference(source)
    const gradients = circuit.backpropagateReference(values, seedsFor(values.length, stepped.position))
    const difference = (name: ParameterName) => centralDifference(value => referenceSpringPower(withParameter(parameters, name, value), stepCount).position, parameters[name])
    return {
      stepCount,
      displacement: values[stepped.displacement]!,
      stiffnessGradient: gradients[cells.stiffness]!,
      stiffnessFiniteDifference: difference('stiffness'),
      destinationGradient: gradients[cells.destination]!,
      destinationFiniteDifference: difference('destination'),
      initialPositionGradient: gradients[cells.position]!,
      initialPositionFiniteDifference: difference('position'),
    }
  })
}
