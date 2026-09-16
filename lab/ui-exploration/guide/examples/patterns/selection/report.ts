// Prints the sizes the selection patterns quote. Run from the repo root:
//   bun lab/ui-exploration/guide/examples/patterns/selection/report.ts
import {emitArgmax, Circuit} from '../../../../../../numeric-ui-core.ts'
import {buildPointedRow} from './count-instead-of-search.ts'
import {buildFirstActiveSelection, buildFirstTargetUnderPointer} from './first-active-tree.ts'
import {buildBestLayout} from './highest-score-tree.ts'
import {measureProgram, nextFloat32Up, type ProgramSize} from './kit.ts'

const describe = (size: ProgramSize) =>
  `${size.operations} operations, ${size.layers} layers, ${size.storedWeights} stored weights${size.gatherReads > 0 ? `, ${size.gatherReads} gathers` : ''}`

console.log('The first active candidate: selection over hit bits in source cells')
for (const count of [4, 15, 16, 64, 1024]) {
  for (const form of ['chain', 'tree'] as const) {
    const built = buildFirstActiveSelection(count, form)
    console.log(`  ${count} candidates, ${form}: ${describe(measureProgram(built.circuit, built.selected))}`)
  }
}
for (const form of ['chain', 'tree'] as const) {
  const built = buildFirstTargetUnderPointer(15, form)
  console.log(`  15 rectangles with hit tests, ${form}: ${describe(measureProgram(built.circuit, [...built.selected, built.pressedTarget, built.pressedLeft]))}`)
  console.log(`    hit bits alone: ${describe(measureProgram(built.circuit, built.hits))}`)
}

console.log('The highest score: selection only')
for (const count of [3, 8, 64]) {
  for (const [form, options] of [['emitArgmax', {}], ['exact tree', {grid: 1 / 64}], ['exact chain', {grid: 1 / 64}], ['exact tree', {}], ['exact chain', {}]] as const) {
    const built = buildBestLayout(count, form, options)
    const gridLabel = 'grid' in options ? ' on a 1/64 grid' : ''
    console.log(`  ${count} layouts, ${form}${gridLabel}: ${describe(measureProgram(built.circuit, built.selected))}`)
  }
}
{
  const built = buildBestLayout(3, 'emitArgmax')
  console.log(`  3 layouts, emitArgmax with the read: ${describe(measureProgram(built.circuit, [built.bestLayout, built.chosenThumbnailWidth]))}`)
}

console.log('emitArgmax keeps the left candidate over a larger right score')
{
  const circuit = new Circuit(3)
  circuit.assumeRange(circuit.source(0), 0, 1)
  circuit.assumeRange(circuit.source(1), 0, 1)
  circuit.assumeRange(circuit.source(2), 1, 1)
  const {selected} = emitArgmax(circuit, [circuit.source(0), circuit.source(1)], circuit.source(2))
  const evaluate = circuit.createTensorEvaluator(selected)
  let largestKept = 0
  let smallestLost = Infinity
  for (let left = 0; left <= 1024; left++) {
    const leftScore = Math.fround(left / 1024 - left / 1_000_000)
    for (let steps = 1; steps <= 8; steps++) {
      const rightScore = nextFloat32Up(leftScore, steps)
      if (rightScore > 1) break
      const keptLeft = evaluate(Float32Array.from([leftScore, rightScore, 1]))[0] === 1
      if (keptLeft) largestKept = Math.max(largestKept, rightScore - leftScore)
      else smallestLost = Math.min(smallestLost, rightScore - leftScore)
    }
  }
  console.log(`  largest right - left that keeps left: ${largestKept}; smallest that picks right: ${smallestLost}`)
}

console.log('Count instead of search: the pointed row, index and one-hot')
for (const count of [16, 64, 256, 1024]) {
  for (const form of ['count', 'tree'] as const) {
    const built = buildPointedRow(count, form)
    console.log(`  ${count} rows, ${form}: ${describe(measureProgram(built.circuit, [built.pointedRow, ...built.isPointedRow]))}`)
  }
}
