// Prints the sizes quoted in the chains section.
// Run from the repo root: bun lab/ui-exploration/guide/examples/chains/report.ts
import {type ButtonOutputs, buildButtonQueue, buttonForms} from './button-forms.ts'
import {measureProgram} from './measure.ts'
import {buildLineStarts} from './pointer-jumping.ts'
import {buildTableMachine} from './table-machine.ts'

const format = (value: number) => value.toLocaleString('en-US')

function printButtonTable(slotCounts: readonly number[], outputs: ButtonOutputs) {
  console.log('| events k | form | operations W | layers D | W / D | stored weights |')
  console.log('| ---: | --- | ---: | ---: | ---: | ---: |')
  for (const slotCount of slotCounts) {
    for (const {label, form} of buttonForms(slotCount)) {
      const built = buildButtonQueue(slotCount, form, outputs)
      const size = measureProgram(built.circuit, built.roots)
      // W / D is the average number of operations per layer: the most that running
      // each layer's operations at the same time could gain over running them one at a time.
      const perLayer = (size.operations / size.layers).toFixed(1)
      console.log(`| ${slotCount} | ${label} | ${format(size.operations)} | ${size.layers} | ${perLayer} | ${format(size.storedWeights)} |`)
    }
  }
}

console.log('## A queue of k button events, outputs: final state and clicks\n')
printButtonTable([4, 16, 64], 'final state and clicks')

console.log('\n## The same queues, outputs: every state after every event\n')
printButtonTable([16, 64], 'every state after every event')

console.log('\n## Line starts from a next-start table\n')
console.log('| segments | line slots | form | operations | layers | stored weights | gather reads |')
console.log('| ---: | ---: | --- | ---: | ---: | ---: | ---: |')
for (const [segmentCount, lineSlots] of [[15, 8], [63, 32]] as const) {
  for (const form of ['sequential', 'pointer jumping'] as const) {
    const built = buildLineStarts(segmentCount, lineSlots, form)
    const size = measureProgram(built.circuit, built.roots)
    console.log(`| ${segmentCount} | ${lineSlots} | ${form} | ${format(size.operations)} | ${size.layers} | ${format(size.storedWeights)} | ${size.gatherReads} |`)
  }
}

console.log('\n## One circuit for any 4-state machine, with its table in source cells\n')
console.log('| events k | operations | layers | stored weights | gather reads |')
console.log('| ---: | ---: | ---: | ---: | ---: |')
for (const slotCount of [4, 16, 64]) {
  const built = buildTableMachine(slotCount)
  const size = measureProgram(built.circuit, built.roots)
  console.log(`| ${slotCount} | ${format(size.operations)} | ${size.layers} | ${format(size.storedWeights)} | ${size.gatherReads} |`)
}
