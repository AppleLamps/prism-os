// Prints the sizes and precision numbers quoted in the instancing section.
// Run from the repository root: bun lab/ui-exploration/guide/examples/instancing/report.ts
import {compareAllVersions} from './card-traces.ts'
import {buildDuplicatedRow, duplicatedRoots, type PrefixLowering} from './cards-duplicated.ts'
import {buildStagedRow, stagedStageSizes} from './cards-staged.ts'
import type {Card} from './cards-types.ts'
import {generatedCode} from './generated-loop.ts'
import {measureCircuit} from './map-stage.ts'
import {buildMaximumCircuit, type MaximumOrder} from './max-order.ts'
import {measurePrefixDrift, syntheticStripSteps} from './prefix-precision.ts'

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// Fractional natural sizes, so no two cards happen to share an operation through the builder's expression table.
function fractionalCards(count: number): Card[] {
  const random = createRandom(12345)
  return Array.from({length: count}, () => ({naturalWidth: 40 + random() * 360, naturalHeight: 40 + random() * 360}))
}

const staged = buildStagedRow()
const stages = stagedStageSizes(staged)
console.log('Staged program, operations per card (the same at every card count):')
for (const stage of stages) console.log(`  map '${stage.name}': ${stage.liveOperations} live operations, ${stage.layers} layers, ${stage.storedWeights} stored weights`)
const perCard = stages.reduce((sum, stage) => sum + stage.liveOperations, 0)
console.log(`  total: ${perCard} operations per card, plus 3 reductions (maximum, prefix sum, first active) as loops`)

for (const prefixLowering of ['chain', 'triangle'] as PrefixLowering[]) {
  console.log(`\nDuplicated circuit, ${prefixLowering} prefix sums:`)
  for (const count of prefixLowering === 'chain' ? [8, 64, 512, 4096] : [8, 64, 512, 2048]) {
    const start = performance.now()
    const row = buildDuplicatedRow(fractionalCards(count), {prefixLowering})
    const size = measureCircuit(row.circuit, duplicatedRoots(row))
    const milliseconds = performance.now() - start
    console.log(`  ${count} cards: ${size.liveOperations} live operations (${(size.liveOperations / count).toFixed(1)} per card), ${size.layers} layers, ${size.storedWeights} stored weights, build + compile ${milliseconds.toFixed(0)} ms`)
  }
}

const comparison = compareAllVersions(staged)
console.log(`\nStaged against duplicated, fractional inputs at 1, 2, 7 and 64 cards, both prefix lowerings:`)
console.log(`  ${comparison.frames} frames, ${comparison.valuesCompared} values compared, ${comparison.differingValues} differing; ${comparison.hoveredFrames} frames with a hovered card, ${comparison.overlappingFrames} with the pointer over two or more cards`)

console.log('\nPrefix sums of synthetic strip widths, largest distance from float64 over all partial sums:')
for (const count of [221, 1000, 10000]) {
  const drift = measurePrefixDrift(syntheticStripSteps(count))
  console.log(`  ${count} photos, total ${drift.total.toFixed(0)} px: one at a time ${drift.sequentialDrift.toFixed(3)} px, Brent-Kung ${drift.brentKungDrift.toFixed(3)} px`)
}

console.log('\nThe tallest of n fractional heights (zoom × natural height + 52), in item order and as a tree, 500 random trials per height count:')
for (const count of [7, 64, 221]) {
  const circuits = (['item order', 'tree'] as MaximumOrder[]).map(order => buildMaximumCircuit(count, order))
  const sizes = circuits.map(built => measureCircuit(built.circuit, [built.tallest]))
  const random = createRandom(777 + count)
  let differing = 0
  let notMathMax = 0
  let largestDistance = 0
  for (let trial = 0; trial < 500; trial++) {
    const zoom = 0.25 + random() * 1.75
    const heights = Float32Array.from({length: count}, () => Math.fround(zoom * (40 + random() * 360) + 52))
    const [ordered, balanced] = circuits.map(built => built.evaluate(heights)) as [number, number]
    const exact = Math.max(...heights)
    if (ordered !== balanced) differing++
    if (ordered !== exact) notMathMax++
    largestDistance = Math.max(largestDistance, Math.abs(ordered - balanced), Math.abs(ordered - exact), Math.abs(balanced - exact))
  }
  console.log(`  ${count} heights: item order ${sizes[0]!.liveOperations} operations / ${sizes[0]!.layers} layers, tree ${sizes[1]!.liveOperations} operations / ${sizes[1]!.layers} layers; the two orders differ in ${differing} trials, item order differs from Math.max in ${notMathMax}; largest distance between any two of them ${largestDistance} px`)
}

const code = generatedCode()
console.log(`\nThe prototype's generated code for a hit test map stage: ${code.counts.sharedRows} operation once per evaluation, ${code.counts.instanceRows} per card`)
console.log('--- shared part (generated JS)')
console.log(code.sharedSource)
console.log('--- per-card part (generated JS)')
console.log(code.instanceSource)
console.log('--- per-card part (WGSL compute shader)')
console.log(code.wgsl)
