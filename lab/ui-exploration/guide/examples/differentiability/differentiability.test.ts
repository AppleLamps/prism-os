import {expect, test} from 'bun:test'
import type {Circuit, Wire} from '../../../../../numeric-ui-core.ts'
import {basicGradientRows} from './basics.ts'
import {buildMaskedUnrolledSpring, buildUnrolledSpring, measureBackwardCost, referenceUnrolledSpring, writeUnrolledSource} from './backward-cost.ts'
import {fitSpringToRecording, framesGradientRows, recordedParameters} from './frames.ts'
import {checkSettledGradients, settledPositionGradients, settledState} from './implicit-spring.ts'
import {checkSettleSnap, findSnapBoundary, gradientError, settlingGradients} from './settle-snap.ts'
import {sourceMatrixGradients} from './source-matrix.ts'
import {
  type SpringCells,
  type SpringParameters,
  buildSpringPowerCircuit,
  centralDifference,
  checkSpringPowerGradients,
  createRandom,
  parameterNames,
  signFloor,
  withParameter,
  writeSpringSource,
} from './spring-power.ts'
import {bisectionLevelDerivative, checkWaterFill, levelGradientByImplicitDifferentiation, solveLevelByBisection} from './water-fill.ts'

const recordedSpring: SpringParameters = {stiffness: 290, damping: 30, stepSeconds: 0.004, destination: 100, position: 0, velocity: 0}

// |value − expected| <= tolerance × max(1, |expected|)
const close = (value: number, expected: number, tolerance = 1e-5) => Math.abs(value - expected) <= tolerance * Math.max(1, Math.abs(expected))

test('each operation: the backward pass against one-sided and central differences', () => {
  const rows = basicGradientRows()
  expect(rows.length).toBe(25)
  const failures: string[] = []
  for (const row of rows) {
    const label = `${row.operation}, ${row.input}, d/d${row.withRespectTo}`
    const sidesAgree = close(row.leftDifference, row.rightDifference)
    if (row.kind === 'step') {
      if (row.leftDifference !== 0 || row.centralDifference !== 0 || row.rightDifference !== 0) failures.push(label)
    } else if (row.backward === null) {
      failures.push(label)
    } else if (row.kind === 'smooth') {
      if (!sidesAgree || !close(row.backward, row.centralDifference)) failures.push(label)
    } else if (row.kind === 'corner') {
      if (sidesAgree || !close(row.backward, row.leftDifference)) failures.push(label)
    } else if (!sidesAgree || close(row.backward, row.centralDifference)) {
      failures.push(label)
    }
  }
  expect(failures).toEqual([])

  const find = (operation: string, input: string, withRespectTo: string) =>
    rows.find(row => row.operation.startsWith(operation) && row.input === input && row.withRespectTo === withRespectTo)!
  expect(find('two ReLU arms', 'a = 3, x = 0', 'x').backward).toBe(0)
  expect(find('`circuit.multiply', 'a = 3, x = 0', 'x').backward).toBe(3)
  expect(find('boolean atom `[a > b]`, default', 'a − b = 2^-10', 'a').thrown).toBe('cannot backpropagate through a boolean atom')
  expect(find('boolean atom `[a > b]`, straight-through', 'a − b = 2^-10', 'a').backward).toBe(256)
  expect(find('boolean atom `[a > b]`, straight-through', 'a − b = 0.25', 'a').backward).toBe(0)
  expect(find('sign cascade', 'd = 0.3', 'd').backward).toBe(0)
  expect(find('sign cascade', 'd = 2^-31', 'd').backward).toBe(2 ** 30)
  // At exactly the resolution the output is a resolved bit, and the backward pass still reports the ramp's slope.
  expect(find('sign cascade', 'd = 2^-30', 'd').output).toBe(1)
  expect(find('sign cascade', 'd = 2^-30', 'd').backward).toBe(2 ** 30)
  expect(find('one-hot read', 'rowIndex = 3', 'rowIndex').backward).toBe(32)
})

test('spring matrix power: gradients of the position after 1 to 300 steps match central differences', () => {
  const check = checkSpringPowerGradients()
  expect(check.pairs).toBe(1080)
  for (const error of Object.values(check.largestErrorByParameter)) expect(error).toBeLessThan(1e-3)
  // The relative error compares gradients below 1e-3 absolutely, so signs are checked separately.
  expect(check.signMismatches).toBe(0)
  // A negated gradient would pass the relative error only late in the motion, where gradients are tiny.
  expect(Object.keys(check.negatedStillPassesByStepCount)).toEqual(['255', '300'])
})

test('source-matrix: stiffness and damping cells get no gradient, and JS can finish the chain rule', () => {
  for (const stepCount of [16, 150, 300]) {
    const result = sourceMatrixGradients(recordedSpring, stepCount)
    expect(result.circuitStiffness).toBe(0)
    expect(result.circuitDamping).toBe(0)
    expect(result.chainedStiffness).not.toBe(0)
    expect(gradientError(result.chainedStiffness, result.finiteDifferenceStiffness)).toBeLessThan(1e-3)
    expect(gradientError(result.chainedDamping, result.finiteDifferenceDamping)).toBeLessThan(1e-3)
  }
})

function largestUnrolledGradientError(circuit: Circuit, cells: SpringCells, source: Float32Array, position: Wire, stepCount: number) {
  const values = circuit.evaluateReference(source)
  const seeds = new Float32Array(values.length)
  seeds[position] = 1
  const gradients = circuit.backpropagateReference(values, seeds)
  return Math.max(...parameterNames.map(name => gradientError(
    gradients[cells[name]]!,
    centralDifference(value => referenceUnrolledSpring(withParameter(recordedSpring, name, value), stepCount).position, recordedSpring[name]),
  )))
}

test('backward cost: unrolled steps grow with the step count, the matrix power stays fixed', () => {
  const power = buildSpringPowerCircuit()
  for (const stepCount of [1, 4, 16, 64, 300]) {
    const unrolled = buildUnrolledSpring(stepCount)
    const source = new Float32Array(unrolled.circuit.sourceSize)
    writeUnrolledSource(source, recordedSpring)
    const cost = measureBackwardCost(unrolled.circuit, source, unrolled.position, 1)
    expect(cost.operationsWalked).toBe(7 * stepCount + 2)
    expect(cost.storedValues).toBe(7 * stepCount + 8)
    expect(largestUnrolledGradientError(unrolled.circuit, unrolled.cells, source, unrolled.position, stepCount)).toBeLessThan(1e-3)

    const powerSource = new Float32Array(power.circuit.sourceSize)
    writeSpringSource(powerSource, power.cells, recordedSpring, stepCount)
    const powerCost = measureBackwardCost(power.circuit, powerSource, power.stepped.position, 1)
    expect(powerCost.operationsWalked).toBe(562)
    expect(powerCost.storedValues).toBe(577)
  }
  const masked = buildMaskedUnrolledSpring(300)
  for (const stepCount of [4, 300]) {
    const source = new Float32Array(masked.circuit.sourceSize)
    writeUnrolledSource(source, recordedSpring, masked.runsStep, stepCount)
    const cost = measureBackwardCost(masked.circuit, source, masked.position, 1)
    expect(cost.operationsWalked).toBe(4202)
    expect(cost.storedValues).toBe(4508)
    expect(largestUnrolledGradientError(masked.circuit, masked.cells, source, masked.position, stepCount)).toBeLessThan(1e-3)
  }
})

test('settle snap: the snapped branch passes only the destination gradient, and the snap moment has none', () => {
  const check = checkSettleSnap()
  expect(check.samples).toBe(200)
  expect(check.snapped).toBeGreaterThan(10)
  expect(check.notSnapped).toBeGreaterThan(10)
  expect(check.settleDecisionDifferences).toBe(0)
  expect(check.snappedGradientMismatches).toBe(0)
  expect(check.notSnappedGradientMismatches).toBe(0)
  expect(check.finiteDifferencePairs).toBeGreaterThan(1000)
  expect(check.largestFiniteDifferenceError).toBeLessThan(1e-3)
  expect(check.straightThroughDifferences).toBe(0)
  expect(check.defaultOptionsMessage).toBe('cannot backpropagate through a boolean atom')

  const boundary = findSnapBoundary()
  expect(boundary.settledBelow + boundary.settledAbove).toBe(1)
  const snappedSideGradient = boundary.settledAbove === 1 ? boundary.gradientAbove : boundary.gradientBelow
  const movingSideGradient = boundary.settledAbove === 1 ? boundary.gradientBelow : boundary.gradientAbove
  expect(snappedSideGradient).toBe(0)
  expect(Math.abs(boundary.finiteDifferenceAcrossTheSnap)).toBeGreaterThan(1e4 * Math.abs(movingSideGradient))
})

test('implicit differentiation: a settled spring\'s gradients, without and with gravity', () => {
  const state = settledState(recordedSpring)
  expect(close(state.position, 100, 1e-12)).toBe(true)
  expect(Math.abs(state.velocity)).toBeLessThan(1e-9)
  const implicit = settledPositionGradients(recordedSpring)
  expect(close(implicit.destination, 1, 1e-9)).toBe(true)
  for (const name of ['stiffness', 'damping', 'stepSeconds', 'position', 'velocity'] as const) {
    expect(Math.abs(implicit[name])).toBeLessThan(1e-9)
  }
  const check = checkSettledGradients(createRandom(5))
  expect(check.largestDistanceFromSettledPosition).toBeLessThan(1e-9)
  expect(check.largestError).toBeLessThan(1e-6)

  // With gravity, the spring settles gravity / stiffness below its destination, so the stiffness
  // slope in the solve multiplies a distance that isn't 0.
  const hanging = {...recordedSpring, gravity: 2000}
  expect(close(settledState(hanging).position, 100 + 2000 / 290, 1e-12)).toBe(true)
  const hangingGradients = settledPositionGradients(hanging)
  expect(close(hangingGradients.stiffness, -2000 / 290 ** 2, 1e-9)).toBe(true)
  expect(close(hangingGradients.gravity, 1 / 290, 1e-9)).toBe(true)
  const gravityCheck = checkSettledGradients(createRandom(6), {withGravity: true})
  expect(gravityCheck.largestStiffnessGradient).toBeGreaterThan(1e-3)
  expect(gravityCheck.largestDistanceFromSettledPosition).toBeLessThan(1e-9)
  expect(gravityCheck.largestError).toBeLessThan(1e-6)

  // Without the snap, the circuit's gradients approach the implicit ones as the spring settles.
  const rows = settlingGradients()
  for (const row of rows) {
    const pairs = [
      [row.stiffnessGradient, row.stiffnessFiniteDifference],
      [row.destinationGradient, row.destinationFiniteDifference],
      [row.initialPositionGradient, row.initialPositionFiniteDifference],
    ] as const
    for (const [backward, difference] of pairs) {
      expect(gradientError(backward, difference)).toBeLessThan(1e-3)
      // gradientError compares gradients below 1e-3 absolutely, so compare signs separately.
      if (Math.abs(difference) >= signFloor) expect(Math.sign(backward)).toBe(Math.sign(difference))
    }
  }
  const settled = rows.at(-1)!
  expect(settled.stepCount).toBe(300)
  expect(Math.abs(settled.stiffnessGradient - implicit.stiffness)).toBeLessThan(1e-6)
  expect(Math.abs(settled.destinationGradient - implicit.destination)).toBeLessThan(1e-6)
  expect(Math.abs(settled.initialPositionGradient - implicit.position)).toBeLessThan(1e-6)
})

test('across frames: backpropagation through time matches central differences of the whole loss, and a fit recovers the spring', () => {
  for (const row of framesGradientRows({...recordedParameters, stiffness: 200, damping: 20})) {
    expect(gradientError(row.backward, row.finiteDifference)).toBeLessThan(1e-4)
  }
  const fit = fitSpringToRecording(200)
  expect(fit.lossAfter).toBeLessThan(fit.lossBefore * 1e-4)
  expect(Math.abs(fit.stiffness - 290)).toBeLessThan(1)
  expect(Math.abs(fit.damping - 30)).toBeLessThan(0.1)
})

test('implicit differentiation of a flex-grow solver matches central differences, where differentiating the bisection loop gives 0', () => {
  const check = checkWaterFill(createRandom(3))
  expect(check.pairs).toBeGreaterThan(600)
  expect(check.largestRelativeError).toBeLessThan(1e-6)
  expect(check.largestBisectionDerivative).toBe(0)

  const row = {containerWidth: 600, growWeights: [1, 2, 1], maximumWidths: [120, 400, 400]}
  const level = solveLevelByBisection(row)
  expect(close(level, 160, 1e-9)).toBe(true)
  expect(close(levelGradientByImplicitDifferentiation(row, level).containerWidth, 1 / 3, 1e-12)).toBe(true)
  expect(bisectionLevelDerivative(row)).toBe(0)
})
