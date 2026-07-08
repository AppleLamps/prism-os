// Full training recovery sweep: 20 scrambled starts, each trained on the same
// harvested pairs, hardened, then verified closed-loop on three held-out
// 10,000-frame traces. Run with: bun lab/event-window/training-sweep.ts
// The printed table goes into README.md.

import {createBehaviorConfig} from './trace.ts'
import {
  createSoftTrainingBuild,
  harvestTrainingPairs,
  scrambledParameterValues,
  trainBehaviorParameters,
  verifyHardenedParameters,
} from './train.ts'

const config = createBehaviorConfig(12_345)
const harvestStart = performance.now()
const pairs = [
  ...harvestTrainingPairs(config, 1_001, 10_000),
  ...harvestTrainingPairs(config, 1_002, 10_000),
]
console.log(`harvested ${pairs.length} pairs from 2 traces x 10,000 frames in ${(performance.now() - harvestStart).toFixed(0)}ms`)
const build = createSoftTrainingBuild()
const heldOutSeeds = [9_001, 9_002, 9_003]

const format = (value: number, digits = 3) => value.toFixed(digits)
console.log('')
console.log('| seed | initial slop | initial title | learned slop | learned title | relations | divergences | recovered |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
let recoveredCount = 0
let totalTrainMs = 0
for (let seed = 1; seed <= 20; seed++) {
  const initial = scrambledParameterValues(seed * 77 + 5)
  const trainStart = performance.now()
  const result = trainBehaviorParameters(build, pairs, {seed, initial})
  totalTrainMs += performance.now() - trainStart
  const report = verifyHardenedParameters(config, result.hardened, heldOutSeeds, 10_000)
  if (report.recovered) recoveredCount++
  const relations = [
    result.hardened.dragFromTitle,
    result.hardened.dragFromBody,
    result.hardened.clickTogglesFromTitle,
    result.hardened.clickTogglesFromBody,
  ].join('')
  const relationsCorrect = relations === '1001' ? `${relations} ✓` : `${relations} ✗`
  console.log(
    `| ${seed} | ${format(initial.slopBoundary, 2)} | ${format(initial.titleBoundary, 2)} `
      + `| ${format(result.learned.slopBoundary)} | ${format(result.learned.titleBoundary)} `
      + `| ${relationsCorrect} | ${report.divergences}/${report.frames} | ${report.recovered ? 'yes' : 'no'} |`,
  )
}
console.log('')
console.log(`recovered ${recoveredCount}/20 seeds; mean training time ${(totalTrainMs / 20).toFixed(0)}ms per seed`)
console.log(`training pairs per seed: ${pairs.length}; steps 2,400 x batch 32 = 76,800 single-frame evaluations`)
