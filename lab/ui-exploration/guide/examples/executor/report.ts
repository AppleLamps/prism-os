// Prints the sizes quoted in sections/executor.md.
// Run from the repo root: bun lab/ui-exploration/guide/examples/executor/report.ts
import {type Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {buildCloseButtonHitTest, describeProgram} from './anatomy.ts'
import {
  buildFixedTimestepProduct,
  buildRanksFromCells,
  buildRanksFromConstants,
  buildVelocityStep,
} from './builder-steps.ts'
import {buildIntegerIndexRead, buildStoredOneHotRead} from './masked-read.ts'
import {
  brentKungNetwork,
  buildChain,
  buildNetwork,
  buildOrdinaryAffineChain,
  buildTriangle,
  koggeStoneNetwork,
} from './prefix-sums.ts'
import {buildCopiedTotal, buildSharedTotal} from './shared-sum.ts'
import {formatStats, measureProgram} from './stats.ts'

function print(label: string, circuit: Circuit, roots: readonly Wire[], lowerGathers = true) {
  console.log(formatStats(label, measureProgram(circuit, roots, lowerGathers)))
}

console.log('# A wide sum that every item reads')
for (const itemCount of [3, 4, 16, 64, 256]) {
  const shared = buildSharedTotal(itemCount)
  const copied = buildCopiedTotal(itemCount)
  print(`${itemCount} items, shared total`, shared.circuit, shared.labelTops)
  print(`${itemCount} items, copied total`, copied.circuit, copied.labelTops)
}

console.log('\n# Reading rowTops[selectedIndex]')
for (const rowCount of [16, 64, 1024]) {
  const integerIndex = buildIntegerIndexRead(rowCount)
  const storedOneHot = buildStoredOneHotRead(rowCount)
  print(`${rowCount} rows, integer index, dense`, integerIndex.circuit, [integerIndex.selectedTop], false)
  print(`${rowCount} rows, integer index, gather lowering`, integerIndex.circuit, [integerIndex.selectedTop])
  print(`${rowCount} rows, stored one-hot, dense`, storedOneHot.circuit, [storedOneHot.selectedTop], false)
  print(`${rowCount} rows, stored one-hot, gather lowering`, storedOneHot.circuit, [storedOneHot.selectedTop])
}

console.log('\n# Running totals of row heights')
for (const rowCount of [64, 256, 1024]) {
  for (const [label, prefix] of [
    ['chain', buildChain(rowCount)],
    ['triangle', buildTriangle(rowCount)],
    ['ordinary affine chain', buildOrdinaryAffineChain(rowCount)],
    ['Brent-Kung', buildNetwork(rowCount, brentKungNetwork(rowCount))],
    ['Kogge-Stone', buildNetwork(rowCount, koggeStoneNetwork(rowCount))],
  ] as const) {
    print(`${rowCount} rows, ${label}`, prefix.circuit, prefix.rowBottoms)
  }
}

console.log('\n# Ranks by width')
for (const itemCount of [8, 32, 64]) {
  const widths = Array.from({length: itemCount}, (_, item) => (item * 37) % 101)
  const constants = buildRanksFromConstants(widths)
  const cells = buildRanksFromCells(itemCount)
  print(`${itemCount} items, widths as constants`, constants.circuit, constants.ranks)
  print(`${itemCount} items, widths in source cells`, cells.circuit, cells.ranks)
}

console.log('\n# velocity * timestep')
for (const declareTimestepFirst of [true, false]) {
  const step = buildVelocityStep(declareTimestepFirst)
  print(`timestep range declared ${declareTimestepFirst ? 'before' : 'after'} the product`, step.circuit, [step.distance])
}

console.log('\n# velocity * 0.004, a timestep known while building')
for (const form of ['weight', 'constant wire'] as const) {
  const step = buildFixedTimestepProduct(form)
  print(`0.004 as a ${form}`, step.circuit, [step.distance])
}

console.log('\n# A close button hit test, layer by layer')
for (const keepButtonEdges of [false, true]) {
  const hitTest = buildCloseButtonHitTest(keepButtonEdges)
  const label = keepButtonEdges ? 'edges kept' : 'edges copied'
  console.log(`\n## ${label}: the builder appended ${hitTest.circuit.operations.length} operations`)
  print(`${label}, roots [pressed]`, hitTest.circuit, [hitTest.pressed])
  print(`${label}, roots [pressed, buttonCenterX]`, hitTest.circuit, [hitTest.pressed, hitTest.buttonCenterX])
  for (const line of describeProgram(hitTest.circuit, [hitTest.pressed], hitTest.names, true)) console.log(line)
}
