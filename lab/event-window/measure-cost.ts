// Circuit cost versus press window size K, plus a step timing measurement.
// Run with: bun lab/event-window/measure-cost.ts
// The printed table goes into README.md.

import {buildEventWindowCircuit, createEventWindowMachine} from './circuit.ts'
import {createOracleState} from './oracle.ts'
import {runClosedLoop} from './harness.ts'
import {measureCircuitCost} from './stats.ts'
import {createBehaviorConfig, generateTrace} from './trace.ts'

console.log('| K | source cells | ops | affine | reglu | boolean | depth | layers | stored weights | max layer width |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const pressRecordCount of [1, 2, 4, 8, 16]) {
  const cost = measureCircuitCost(buildEventWindowCircuit('exact', pressRecordCount))
  console.log(
    `| ${pressRecordCount} | ${cost.sourceCells} | ${cost.operations} | ${cost.affine} `
      + `| ${cost.reglu} | ${cost.boolean} | ${cost.depth} | ${cost.layerCount} `
      + `| ${cost.storedWeights} | ${cost.maxLayerWidth} |`,
  )
}

const softCost = measureCircuitCost(buildEventWindowCircuit('soft', 1))
console.log('')
console.log(
  `soft training circuit (K = 1): ${softCost.operations} ops `
    + `(${softCost.affine} affine, ${softCost.reglu} reglu, ${softCost.boolean} boolean), depth ${softCost.depth}`,
)

const config = createBehaviorConfig(12_345)
const trace = generateTrace(config, 4_242, 10_000)
const machine = createEventWindowMachine(config)
const start = performance.now()
const result = runClosedLoop(config, trace, machine, createOracleState(config))
const elapsed = performance.now() - start
console.log('')
console.log(
  `closed loop, tensor evaluator, K = 1: ${result.frames} frames in ${elapsed.toFixed(0)}ms `
    + `(${(elapsed / result.frames * 1000).toFixed(1)}µs per frame, oracle comparison included), divergences ${result.divergences}`,
)
