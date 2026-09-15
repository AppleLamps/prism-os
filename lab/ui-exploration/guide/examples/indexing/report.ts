// Prints the operation counts and toy results that sections/indexing.md cites.
// Run from the repo root: bun lab/ui-exploration/guide/examples/indexing/report.ts
import {programStatistics} from '../../../index-read/measure.ts'
import {buildHardAttentionRead, buildRuntimeKeyHardAttention} from './hard-attention.ts'
import {buildIndexRead, buildLinearReadFromIndexReads} from './index-read-instruction.ts'
import {
  authoredWeights,
  buildSnapCircuit,
  buildSquaredErrorCircuit,
  buildTrainingCircuit,
  countSnapMatches,
  learnQueryWeights,
  learnQueryWeightsBySquaredError,
  type QueryWeights,
} from './learned-query.ts'
import {buildLinearRead, linearRead} from './linear-read.ts'
import {centralDifference, countProgram} from './measure.ts'
import {buildOneHotRead} from './one-hot-read.ts'
import {descendLinearRead, descendSoftAttention, matchLoss, sharpnessSchedule} from './query-descent.ts'
import {
  buildSoftAttentionRead,
  maximumSharpness,
  minimumSharpness,
  softAttentionGradient,
  softAttentionRead,
  softAttentionWeights,
} from './soft-attention.ts'

type Row = {construction: string, entries: number, liveOperations: number, layers: number, storedWeights: number, reads: number}
const rows: Row[] = []

for (const entries of [8, 64, 1024]) {
  const oneHot = buildOneHotRead(entries, {declareOneHot: true})
  const dense = countProgram(oneHot.circuit, [oneHot.read], false)
  rows.push({construction: 'one-hot masked sum, dense', entries, ...dense, reads: 0})
  const lowered = countProgram(oneHot.circuit, [oneHot.read], true)
  rows.push({construction: 'one-hot masked sum, gather lowering', entries, ...lowered, reads: lowered.gatherReads})
  const instruction = programStatistics(buildIndexRead(entries).circuit.compileTensorProgram([buildIndexRead(entries).read]))
  rows.push({construction: 'index read instruction', entries, liveOperations: instruction.liveOperations, layers: instruction.layers, storedWeights: instruction.storedWeights, reads: instruction.indexReads})
  const linear = buildLinearRead(entries)
  rows.push({construction: 'linear interpolation, tent weights', entries, ...countProgram(linear.circuit, [linear.read]), reads: 0})
  const linearFromReads = buildLinearReadFromIndexReads(entries)
  const linearStatistics = programStatistics(linearFromReads.circuit.compileTensorProgram([linearFromReads.read]))
  rows.push({construction: 'linear interpolation, index reads', entries, liveOperations: linearStatistics.liveOperations, layers: linearStatistics.layers, storedWeights: linearStatistics.storedWeights, reads: linearStatistics.indexReads})
  if (entries <= 64) {
    const soft = buildSoftAttentionRead(entries)
    rows.push({construction: 'soft attention, parabola keys', entries, ...countProgram(soft.circuit, [soft.read]), reads: 0})
    const hard = buildHardAttentionRead(entries)
    rows.push({construction: 'hard attention, argmax, dense', entries, ...countProgram(hard.circuit, [hard.read], false), reads: 0})
    const hardLowered = countProgram(hard.circuit, [hard.read], true)
    rows.push({construction: 'hard attention, argmax, gather lowering', entries, ...hardLowered, reads: hardLowered.gatherReads})
  }
}
console.table(rows.map(({construction, entries, liveOperations, layers, storedWeights, reads}) =>
  ({construction, entries, liveOperations, layers, storedWeights, reads})))

// Soft attention against float64, over rowHeights, 6 sharpness values and queries on a 1/8 grid.
const rowHeights = [28, 44, 28, 60, 36, 28, 52, 40]
{
  const soft = buildSoftAttentionRead(8)
  let worstRead = 0
  let worstQueryGradient = 0
  let worstSharpnessGradient = 0
  let smallestTotal = Number.POSITIVE_INFINITY
  let largestTotal = Number.NEGATIVE_INFINITY
  for (const sharpness of [0.25, 0.5, 1, 2, 4, 8]) {
    for (let query = 0; query <= 7; query += 0.125) {
      const values = soft.circuit.evaluateReference(soft.source(query, sharpness, rowHeights))
      const outputGradients = new Float32Array(values.length)
      outputGradients[soft.read] = 1
      const gradients = soft.circuit.backpropagateReference(values, outputGradients)
      const expected = softAttentionGradient(rowHeights, query, sharpness)
      worstRead = Math.max(worstRead, Math.abs(values[soft.read]! - softAttentionRead(rowHeights, query, sharpness)))
      worstQueryGradient = Math.max(worstQueryGradient, Math.abs(gradients[soft.query]! - expected.query))
      worstSharpnessGradient = Math.max(worstSharpnessGradient, Math.abs(gradients[soft.sharpness]! - expected.sharpness))
      smallestTotal = Math.min(smallestTotal, values[soft.total]!)
      largestTotal = Math.max(largestTotal, values[soft.total]!)
    }
  }
  console.log(`soft attention against float64: worst read error ${worstRead.toExponential(2)}, worst query gradient error ${worstQueryGradient.toExponential(2)}, worst sharpness gradient error ${worstSharpnessGradient.toExponential(2)}, sum of exponentials within ${smallestTotal.toFixed(4)}..${largestTotal.toFixed(4)}`)
  const query = 2.3
  const sharpness = 1
  const values = soft.circuit.evaluateReference(soft.source(query, sharpness, rowHeights))
  const outputGradients = new Float32Array(values.length)
  outputGradients[soft.read] = 1
  const gradients = soft.circuit.backpropagateReference(values, outputGradients)
  const evaluateQuery = (at: number) => soft.circuit.evaluateReference(soft.source(at, sharpness, rowHeights))[soft.read]!
  console.log(`soft attention at query 2.3, sharpness 1: read ${values[soft.read]!.toFixed(4)} (float64 ${softAttentionRead(rowHeights, query, sharpness).toFixed(4)}), query gradient ${gradients[soft.query]!.toFixed(4)}, derivative ${softAttentionGradient(rowHeights, query, sharpness).query.toFixed(4)}, central difference with step 0.01 ${centralDifference(evaluateQuery, query, 0.01).toFixed(4)}`)
  for (const sharpnessValue of [1, 8, 64]) {
    console.log(`softmax weight on position 2 at query 2.25, sharpness ${sharpnessValue}: ${softAttentionWeights(8, 2.25, sharpnessValue)[2]!.toFixed(5)}`)
  }
}

const itemIds = [41, 7, 23, 88, 15, 64, 30, 52]
const targetId = 64
const entryLosses = matchLoss(itemIds, targetId)
const schedule = sharpnessSchedule(minimumSharpness, maximumSharpness, 80, 40)
for (const startQuery of [0, 1.2, 2.7, 4, 6.5, 7]) {
  const queries = descendSoftAttention(entryLosses, {startQuery, steps: 140, learningRate: 1, maximumStep: 0.5, sharpnessAt: schedule})
  const finalQuery = queries.at(-1)!
  const everyTwentySteps = queries.filter((_, step) => step % 20 === 0).map(query => query.toFixed(2)).join(', ')
  console.log(`soft attention, wide then sharp, start ${startQuery}: ${everyTwentySteps}, final ${finalQuery.toFixed(4)}, weight on position 5 at sharpness 8: ${softAttentionWeights(8, finalQuery, 8)[5]!.toFixed(4)}`)
}
const sharpOnly = descendSoftAttention(entryLosses, {startQuery: 1.2, steps: 140, learningRate: 1, maximumStep: 0.5, sharpnessAt: () => maximumSharpness})
console.log(`soft attention, sharp only, start 1.2: final ${sharpOnly.at(-1)!.toFixed(4)}`)
const wideOnly = descendSoftAttention(entryLosses, {startQuery: 1.2, steps: 140, learningRate: 1, maximumStep: 0.5, sharpnessAt: () => minimumSharpness})
console.log(`soft attention, wide only, start 1.2: final ${wideOnly.at(-1)!.toFixed(4)}`)
for (const startQuery of [1.2, 4.3]) {
  const queries = descendLinearRead(entryLosses, {startQuery, steps: 140, learningRate: 0.2, maximumStep: 0.5, loss: 'read'})
  console.log(`linear interpolation, per-entry loss, start ${startQuery}: last queries ${queries.slice(-3).map(query => query.toFixed(3)).join(', ')}`)
}
const blended = descendLinearRead(itemIds, {startQuery: 1.2, steps: 140, learningRate: 0.2, maximumStep: 0.5, loss: {target: targetId, scale: 100}})
const blendedQuery = blended.at(-1)!
console.log(`linear interpolation, loss on the blended value, start 1.2: final ${blendedQuery.toFixed(4)}, read ${linearRead(itemIds, blendedQuery).toFixed(4)}, entry at the rounded query ${itemIds[Math.round(blendedQuery)]}`)
console.log(`sharp only, start 1.2, exact final query: ${sharpOnly.at(-1)}, weight on position 5 at the start: ${softAttentionWeights(8, 1.2, 8)[5]!.toExponential(2)}`)

// Hard attention with runtime keys.
for (const count of [8, 64]) {
  const reader = buildRuntimeKeyHardAttention(count, 256)
  console.log(`runtime keys, ${count} targets: dense ${JSON.stringify(countProgram(reader.circuit, [reader.snapX], false))}, lowered ${JSON.stringify(countProgram(reader.circuit, [reader.snapX], true))}`)
}

// Learning the weights that compute a query.
const describeWeights = (weights: QueryWeights) =>
  `weightRelease ${weights.weightRelease.toFixed(4)}, weightVelocity ${weights.weightVelocity.toFixed(4)}, bias ${weights.bias.toFixed(4)}`
const describeMatches = (weights: QueryWeights) => {
  const result = countSnapMatches(weights)
  return `${result.matches} of ${result.total} releases match, largest mismatch within ${result.largestMismatchDistance.toFixed(4)} page of a boundary`
}
console.log(`snap circuit with authored weights (1/4.5 = ${(1 / 4.5).toFixed(4)}): ${describeMatches(authoredWeights)}`)
{
  const training = buildTrainingCircuit()
  const snap = buildSnapCircuit()
  const control = buildSquaredErrorCircuit()
  console.log(`training circuit ${JSON.stringify(countProgram(training.circuit, [training.read]))}, snap circuit ${JSON.stringify(countProgram(snap.circuit, [snap.snapPage]))}, squared-error circuit ${JSON.stringify(countProgram(control.circuit, [control.loss]))}`)
}
const learningStarts: {label: string, start: QueryWeights}[] = [
  {label: 'nearest page, ignoring velocity', start: {weightRelease: 1, weightVelocity: 0, bias: 3.5}},
  {label: 'always the middle page', start: {weightRelease: 0, weightVelocity: 0, bias: 3.5}},
  {label: 'projecting the wrong way', start: {weightRelease: 0.5, weightVelocity: -0.5, bias: 1}},
]
for (const {label, start} of learningStarts) {
  for (const seed of [1, 2]) {
    for (const learningRate of [0.05, 0.1]) {
      const weights = learnQueryWeights({start, steps: 400, batchSize: 16, learningRate, seed})
      console.log(`soft read, start "${label}", seed ${seed}, learning rate ${learningRate}: ${describeWeights(weights)}; ${describeMatches(weights)}`)
    }
  }
}
for (const {label, start} of learningStarts) {
  const weights = learnQueryWeightsBySquaredError({start, steps: 400, batchSize: 16, learningRate: 0.02, seed: 1})
  console.log(`squared-error control, start "${label}", seed 1, learning rate 0.02: ${describeWeights(weights)}; ${describeMatches(weights)}`)
}
