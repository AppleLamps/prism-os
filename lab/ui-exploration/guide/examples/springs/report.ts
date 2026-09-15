// Prints every number the springs section quotes from these examples.
// Run from the repo root: bun lab/ui-exploration/guide/examples/springs/report.ts
import {createHighlightMachine, topConstants} from './app-frame.ts'
import {checkBuildOrder} from './build-order.ts'
import {
  checkAppFreeRunning,
  checkAppRestartedEveryFrame,
  checkCatchUpForm,
  checkClock,
  checkGoToEnd,
  checkSpringStep,
  checkStepSpringTo,
  measureDigitOrderDepth,
} from './checks.ts'
import {
  buildCatchUp,
  buildCatchUpWithConstantCells,
  buildIndirectOsSpring,
  catchUpForms,
  measureProgram,
} from './costs.ts'
import {timingRules, worstOverSeeds} from './frame-rate-check.ts'

const format = (value: number) => value === 0 ? '0' : Math.abs(value) >= 1 ? value.toPrecision(3) : value.toExponential(1)

console.log('## Level 1: emitSpringStep')
const step = checkSpringStep(2000)
console.log(`one step: ${step.oneStepSize.liveOperations} live operations, ${step.oneStepSize.layers} layer, max displacement error ${format(step.maxOneStepError)} px`)
console.log(`300 chained steps: ${step.chainedSize.liveOperations} live operations, ${step.chainedSize.layers} layer, ${step.chainedSize.storedWeights} stored weights, max displacement error ${format(step.maxChainedError)} px; the builder created ${step.createdOperations} operations in total`)

console.log('\n## Level 2: emitStepSpringTo, 9 step digits written by JS')
console.log(checkStepSpringTo(5, 20_000))
console.log('goToEnd', checkGoToEnd(8, 20_000))

console.log('\n## Clock')
console.log(checkClock(3))
console.log('clock plus one spring, by digit order', measureDigitOrderDepth())

console.log('\n## Level 3: the highlight app')
const machine = createHighlightMachine()
console.log('size', measureProgram(machine.circuit, machine.roots))
for (const seed of [1, 2, 3]) {
  console.log('restarted every frame, seed', seed, checkAppRestartedEveryFrame(seed, 5000))
  console.log('free-running, seed', seed, checkAppFreeRunning(seed, 5000))
}

console.log('\n## Catch-up forms against float64')
for (const form of catchUpForms) console.log(form, checkCatchUpForm(form, 9, 2000))

console.log('\n## Catch-up costs (no settle snap), stiffness 290 and damping 30 in weights')
console.log('| Form | 1 spring: live ops / layers / weights | 20 springs: live ops / layers / weights |')
console.log('| --- | --- | --- |')
for (const form of catchUpForms) {
  const one = buildCatchUp(form, 1, topConstants)
  const twenty = buildCatchUp(form, 20, topConstants)
  const oneSize = measureProgram(one.circuit, one.roots)
  const twentySize = measureProgram(twenty.circuit, twenty.roots)
  console.log(`| ${form} | ${oneSize.liveOperations} / ${oneSize.layers} / ${oneSize.storedWeights} | ${twentySize.liveOperations} / ${twentySize.layers} / ${twentySize.storedWeights} |`)
}
for (const form of ['unrolled, one mask per step', 'binary digits, per spring'] as const) {
  const one = buildCatchUpWithConstantCells(form, 1)
  const size = measureProgram(one.circuit, one.roots)
  console.log(`| ${form}, stiffness and damping in cells | ${size.liveOperations} / ${size.layers} / ${size.storedWeights} | |`)
}
const indirectOs = buildIndirectOsSpring()
console.log('IndirectOS emitSpring, one spring, with settle', measureProgram(indirectOs.circuit, indirectOs.roots))

console.log('\n## Statement order')
console.log(checkBuildOrder(4, 100_000))

console.log('\n## Frame-rate dependence, max position difference from 120 fps (px), worst over 8 traces of 12 presses')
console.log('| Timing rule | 10 fps | 30 fps | 60 fps | 60 fps, 500 ms stall |')
console.log('| --- | ---: | ---: | ---: | ---: |')
for (const pressesOnFramesOfHz of [undefined, 30]) {
  console.log(pressesOnFramesOfHz === undefined ? '| presses between frames | | | | |' : '| presses on 30 fps frame times | | | | |')
  for (const rule of timingRules) {
    const cells = [
      worstOverSeeds(rule, 10, {stall: false, pressesOnFramesOfHz}),
      worstOverSeeds(rule, 30, {stall: false, pressesOnFramesOfHz}),
      worstOverSeeds(rule, 60, {stall: false, pressesOnFramesOfHz}),
      worstOverSeeds(rule, 60, {stall: true, pressesOnFramesOfHz}),
    ].map(comparison => format(comparison.maxDifferencePx))
    console.log(`| ${rule} | ${cells.join(' | ')} |`)
  }
}

console.log('\n## index.ts order, presses only while the spring is at rest, max position difference from 120 fps (px)')
console.log('| Press times | 10 fps | 30 fps | 60 fps |')
console.log('| --- | ---: | ---: | ---: |')
for (const pressesOnFramesOfHz of [10, undefined]) {
  const cells = [10, 30, 60].map(hz =>
    format(worstOverSeeds('index.ts', hz, {stall: false, pressesOnFramesOfHz, spacing: 'only at rest'}).maxDifferencePx))
  console.log(`| ${pressesOnFramesOfHz === undefined ? 'between frames' : 'on 10 fps frame times'} | ${cells.join(' | ')} |`)
}
