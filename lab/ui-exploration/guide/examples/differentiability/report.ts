// Prints every number the differentiability section quotes from these examples.
// Run from the repo root: bun lab/ui-exploration/guide/examples/differentiability/report.ts
import {basicGradientRows} from './basics.ts'
import {buildMaskedUnrolledSpring, buildUnrolledSpring, measureBackwardCost, referenceUnrolledSpring, writeUnrolledSource} from './backward-cost.ts'
import {fitSpringToRecording, frameSchedule, framesGradientRows, lossAndGradientsThroughFrames, recordedParameters, referenceTrajectory} from './frames.ts'
import {checkSettledGradients, settledPositionGradients, settledState} from './implicit-spring.ts'
import {checkSettleSnap, findSnapBoundary, settlingGradients} from './settle-snap.ts'
import {sourceMatrixGradients} from './source-matrix.ts'
import {type SpringParameters, buildSpringPowerCircuit, checkSpringPowerGradients, createRandom, signFloor, writeSpringSource} from './spring-power.ts'
import {bisectionLevelDerivative, checkWaterFill, childWidths, levelGradientByImplicitDifferentiation, solveLevelByBisection} from './water-fill.ts'

const format = (value: number | null) => {
  if (value === null) return 'throws'
  if (value === 0) return '0'
  if (!Number.isFinite(value)) return String(value)
  const magnitude = Math.abs(value)
  return magnitude >= 1e-3 && magnitude < 1e7 ? String(Number(value.toPrecision(5))) : value.toExponential(2)
}

const recordedSpring: SpringParameters = {stiffness: 290, damping: 30, stepSeconds: 0.004, destination: 100, position: 0, velocity: 0}

console.log('## What the backward pass reports for each operation')
for (const row of basicGradientRows()) {
  const backward = row.backward === null ? `throws "${row.thrown}"` : format(row.backward)
  console.log(`${row.operation} | ${row.input} | d/d${row.withRespectTo} | ${row.kind} | output ${format(row.output)} | backward ${backward} | left ${format(row.leftDifference)} | central ${format(row.centralDifference)} | right ${format(row.rightDifference)}`)
}

console.log('\n## Spring as a matrix power with stiffness, damping and step duration in cells')
{
  const {circuit, frame, stepped} = buildSpringPowerCircuit()
  const whole = circuit.compileTensorProgram([stepped.position, stepped.velocity])
  const frameOnly = circuit.compileTensorProgram([...frame])
  const live = (program: typeof whole) => program.layers.reduce((sum, layer) => sum + layer.outputSize, 0)
  const weights = (program: typeof whole) => program.layers.reduce((sum, layer) => sum + layer.weights.length, 0)
  console.log(`built operations ${circuit.operations.length}; position and velocity: ${live(whole)} live operations, ${whole.layers.length} layers, ${weights(whole)} stored weights; frame matrix alone: ${live(frameOnly)} live operations, ${frameOnly.layers.length} layers`)
  const check = checkSpringPowerGradients()
  console.log(`step counts ${check.stepCounts.join(', ')}; ${check.pairs} (sample, parameter) pairs`)
  for (const [name, error] of Object.entries(check.largestErrorByParameter)) console.log(`  largest relative error, ${name}: ${format(error)}`)
  console.log(`  pairs where a negated gradient would still pass, by step count: ${JSON.stringify(check.negatedStillPassesByStepCount)}`)
  console.log(`  pairs whose central difference is below ${signFloor}, by step count: ${JSON.stringify(check.belowSignFloorByStepCount)}; sign mismatches above that floor: ${check.signMismatches}`)
}

console.log('\n## spring-bank source-matrix in miniature: JS writes M^steps into 4 cells')
for (const stepCount of [16, 150, 300]) {
  const result = sourceMatrixGradients(recordedSpring, stepCount)
  console.log(`n = ${stepCount}: circuit d/dstiffness ${format(result.circuitStiffness)}, d/ddamping ${format(result.circuitDamping)}; chain rule finished in JS ${format(result.chainedStiffness)}, ${format(result.chainedDamping)}; central difference ${format(result.finiteDifferenceStiffness)}, ${format(result.finiteDifferenceDamping)}`)
}

console.log('\n## Backward pass cost: unrolled steps against the matrix power')
{
  const power = buildSpringPowerCircuit()
  for (const stepCount of [1, 4, 16, 64, 300]) {
    const unrolled = buildUnrolledSpring(stepCount)
    const unrolledSource = new Float32Array(unrolled.circuit.sourceSize)
    writeUnrolledSource(unrolledSource, recordedSpring)
    const unrolledCost = measureBackwardCost(unrolled.circuit, unrolledSource, unrolled.position, 100)
    const unrolledError = unrolled.circuit.evaluateReference(unrolledSource)[unrolled.position]! - referenceUnrolledSpring(recordedSpring, stepCount).position
    const powerSource = new Float32Array(power.circuit.sourceSize)
    writeSpringSource(powerSource, power.cells, recordedSpring, stepCount)
    const powerCost = measureBackwardCost(power.circuit, powerSource, power.stepped.position, 100)
    console.log(`n = ${stepCount}: unrolled ${unrolledCost.operationsWalked} operations walked, ${unrolledCost.operationsReceivingGradient} receive a gradient, ${unrolledCost.storedValues} stored values, ${unrolledCost.layers} layers, ${format(unrolledCost.backwardMicroseconds)} µs (position error ${format(unrolledError)} px) | matrix power ${powerCost.operationsWalked} walked, ${powerCost.operationsReceivingGradient} receive a gradient, ${powerCost.storedValues} stored values, ${powerCost.layers} layers, ${format(powerCost.backwardMicroseconds)} µs`)
  }
  const masked = buildMaskedUnrolledSpring(300)
  for (const stepCount of [4, 300]) {
    const source = new Float32Array(masked.circuit.sourceSize)
    writeUnrolledSource(source, recordedSpring, masked.runsStep, stepCount)
    const cost = measureBackwardCost(masked.circuit, source, masked.position, 50)
    console.log(`masked unrolled, up to 300 steps, n = ${stepCount}: ${cost.operationsWalked} walked, ${cost.operationsReceivingGradient} receive a gradient, ${cost.storedValues} stored values, ${cost.layers} layers, ${format(cost.backwardMicroseconds)} µs`)
  }
}

console.log('\n## Settle snap')
{
  const check = checkSettleSnap()
  console.log(JSON.stringify(check))
  const boundary = findSnapBoundary()
  console.log(`n = ${boundary.stepCount}: stiffness ${boundary.stiffnessBelow} gives settled ${boundary.settledBelow}, position ${boundary.positionBelow}, gradient ${format(boundary.gradientBelow)}; stiffness ${boundary.stiffnessAbove} gives settled ${boundary.settledAbove}, position ${boundary.positionAbove}, gradient ${format(boundary.gradientAbove)}; difference across the snap ${format(boundary.finiteDifferenceAcrossTheSnap)}`)
  for (const row of settlingGradients()) {
    console.log(`without the snap, n = ${row.stepCount}: displacement ${format(row.displacement)}; d/dstiffness ${format(row.stiffnessGradient)} (central difference ${format(row.stiffnessFiniteDifference)}); d/ddestination ${format(row.destinationGradient)} (${format(row.destinationFiniteDifference)}); d/dinitial position ${format(row.initialPositionGradient)} (${format(row.initialPositionFiniteDifference)})`)
  }
  const state = settledState(recordedSpring)
  const implicit = settledPositionGradients(recordedSpring)
  console.log(`implicit differentiation: settled state (${format(state.position)}, ${format(state.velocity)}); gradients ${Object.entries(implicit).map(([name, value]) => `${name} ${format(value)}`).join(', ')}`)
  const implicitCheck = checkSettledGradients(createRandom(5))
  console.log(`against a 4,096-step float64 simulation over ${implicitCheck.samples} random springs: largest error ${format(implicitCheck.largestError)}, largest distance from the settled position ${format(implicitCheck.largestDistanceFromSettledPosition)}, largest |d position / d stiffness| ${format(implicitCheck.largestStiffnessGradient)}`)
  const hanging = {...recordedSpring, gravity: 2000}
  console.log(`with gravity 2,000 px/s²: settled position ${format(settledState(hanging).position)}; gradients ${Object.entries(settledPositionGradients(hanging)).map(([name, value]) => `${name} ${format(value)}`).join(', ')}`)
  const gravityCheck = checkSettledGradients(createRandom(6), {withGravity: true})
  console.log(`with gravity between 0 and 4,000 px/s², over ${gravityCheck.samples} random springs: largest error ${format(gravityCheck.largestError)}, largest distance from the settled position ${format(gravityCheck.largestDistanceFromSettledPosition)}, largest |d position / d stiffness| ${format(gravityCheck.largestStiffnessGradient)}`)
  const zeroStiffness = settledPositionGradients({...recordedSpring, stiffness: 0})
  console.log(`stiffness 0: settled position ${format(settledState({...recordedSpring, stiffness: 0}).position)}, d position / d destination ${format(zeroStiffness.destination)}`)
}

console.log('\n## Training across frames')
{
  const start = {...recordedParameters, stiffness: 200, damping: 20}
  const totalSteps = frameSchedule.reduce((sum, steps) => sum + steps, 0)
  const recorded = referenceTrajectory(recordedParameters, frameSchedule)
  const through = lossAndGradientsThroughFrames(start, frameSchedule, recorded)
  console.log(`${through.frames} frames, ${totalSteps} steps in total; ${through.operationsPerFrame} operations and ${through.storedValuesPerFrame} stored values per frame`)
  for (const row of framesGradientRows(start)) console.log(`d loss / d ${row.name}: backward ${format(row.backward)}, central difference ${format(row.finiteDifference)}`)
  const startTime = performance.now()
  const fit = fitSpringToRecording(200)
  console.log(`Adam, ${fit.iterations} iterations: loss ${format(fit.lossBefore)} to ${format(fit.lossAfter)}, stiffness ${format(fit.stiffness)}, damping ${format(fit.damping)}, ${(performance.now() - startTime).toFixed(0)} ms`)
}

console.log('\n## Implicit differentiation of a layout solver')
{
  const row = {containerWidth: 600, growWeights: [1, 2, 1], maximumWidths: [120, 400, 400]}
  const level = solveLevelByBisection(row)
  const implicit = levelGradientByImplicitDifferentiation(row, level)
  console.log(`container 600 px, grow weights 1, 2, 1, maximum widths 120, 400, 400: level ${format(level)}, widths ${childWidths(row, level).map(format).join(', ')}; d level / d container width ${format(implicit.containerWidth)} by implicit differentiation, ${format(bisectionLevelDerivative(row))} through the bisection loop; d level / d maximum widths ${implicit.maximumWidths.map(format).join(', ')}; d level / d grow weights ${implicit.growWeights.map(format).join(', ')}`)
  console.log(JSON.stringify(checkWaterFill(createRandom(3))))
  const wideRow = {containerWidth: 1000, growWeights: [1, 2, 1], maximumWidths: [120, 400, 400]}
  const wideLevel = solveLevelByBisection(wideRow)
  console.log(`container 1,000 px, wider than the maximum widths added up (920 px): level ${format(wideLevel)}, widths ${childWidths(wideRow, wideLevel).map(format).join(', ')}; d level / d container width ${format(levelGradientByImplicitDifferentiation(wideRow, wideLevel).containerWidth)}`)
}
