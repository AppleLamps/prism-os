import {expect, test} from 'bun:test'
import {createCandidateGalleryMachine, sourceField as candidateSourceField} from './candidate-gallery-copy.ts'
import {sameFloat} from './codegen.ts'
import {compileInstanceProgram, createBatchedExecutor, instanceSourceTable, planInstances, type InstanceRunner} from './instance.ts'
import {buildRandomCircuit, createRandom, randomSource} from './random-circuit.ts'
import {createCandidateGridWorkload} from './workloads.ts'

// Instance cell sets never split the source one-hot group (cells 0..3), so
// every per-instance source table keeps its one-hot contract.
const instanceCellSets = [[4, 5], [0, 1, 2, 3], [8], [11, 6], [0, 1, 2, 3, 7, 9]]

test('both instance backends match the reference evaluator on every live wire of every instance, block by block', () => {
  let checkedValues = 0
  let checkedOutputs = 0
  let laterBlocks = 0
  let instanceGatherSlots = 0
  for (let seed = 1; seed <= 40; seed++) {
    const {circuit, sources, all} = buildRandomCircuit(seed)
    const program = circuit.compileTensorProgram()
    const random = createRandom(seed * 7919)
    const instanceCells = instanceCellSets[seed % instanceCellSets.length]!
    const outputs = all.filter(wire => wire >= circuit.sourceSize)
    const plan = planInstances(program, instanceCells, outputs)
    instanceGatherSlots += plan.instanceSlotCount
    const count = 37
    const blockSize = [3, 7, 16][seed % 3]!
    const instanceSources = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const other = randomSource(random, true)
      instanceCells.forEach((cell, column) => {
        instanceSources[instance * instanceCells.length + column] = other[cell]!
      })
    }
    const sharedSource = sources[0]!
    const references = Array.from({length: count}, (_, instance) => circuit.evaluateReference(instanceSourceTable(plan, sharedSource, instanceSources, instance)))
    const finite = references.map(reference => Array.from(program.wireOrder, wire => reference[wire]!).every(value => Number.isFinite(value)))
    const runners: InstanceRunner[] = [
      compileInstanceProgram(plan, {rowsPerFunction: 1 + (seed % 7), blockSize}),
      createBatchedExecutor(plan, blockSize),
    ]
    const outputTables = runners.map(() => new Float32Array(count * outputs.length))
    for (const runner of runners) runner.runShared(sharedSource)
    // lastBlockValue only sees the last block a run went through, so each run
    // goes one block further: the run over the first `end` instances leaves
    // the block starting at blockStart in the backend's buffers.
    for (let blockStart = 0; blockStart < count; blockStart += blockSize) {
      const end = Math.min(count, blockStart + blockSize)
      runners.forEach((runner, index) => runner.runInstances(instanceSources, end, outputTables[index]!))
      if (blockStart > 0) laterBlocks++
      for (let instance = blockStart; instance < end; instance++) {
        if (!finite[instance]) continue
        for (let position = 0; position < program.valueCount; position++) {
          const expected = references[instance]![program.wireOrder[position]!]!
          for (const runner of runners) {
            const actual = runner.lastBlockValue(instance - blockStart, position)
            if (!sameFloat(actual, expected)) {
              throw new Error(`seed ${seed} block size ${blockSize} instance ${instance} packed ${position}: backend ${actual}, reference ${expected}`)
            }
          }
          checkedValues++
        }
      }
    }
    // The requested outputs of every instance, written across all blocks by the last run.
    for (let instance = 0; instance < count; instance++) {
      if (!finite[instance]) continue
      outputs.forEach((wire, output) => {
        for (const table of outputTables) {
          if (!sameFloat(table[instance * outputs.length + output]!, references[instance]![wire]!)) {
            throw new Error(`seed ${seed} instance ${instance} output wire ${wire}: backend ${table[instance * outputs.length + output]}, reference ${references[instance]![wire]}`)
          }
        }
        checkedOutputs++
      })
    }
  }
  expect(instanceGatherSlots).toBeGreaterThan(5)
  expect(laterBlocks).toBeGreaterThan(40)
  expect(checkedValues).toBeGreaterThan(300_000)
  expect(checkedOutputs).toBeGreaterThan(50_000)
})

test('instance outputs stay identical across block sizes and agree with the executor when contracts break', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const {circuit, sources, all} = buildRandomCircuit(seed, {keepContracts: false})
    const program = circuit.compileTensorProgram()
    const random = createRandom(seed * 104729)
    const instanceCells = instanceCellSets[seed % instanceCellSets.length]!
    const outputs = all.filter(wire => wire >= circuit.sourceSize)
    const plan = planInstances(program, instanceCells, outputs)
    const count = 37
    const instanceSources = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const other = randomSource(random)
      instanceCells.forEach((cell, column) => {
        instanceSources[instance * instanceCells.length + column] = other[cell]!
      })
    }
    const sharedSource = sources[1]!
    const results = [
      compileInstanceProgram(plan, {rowsPerFunction: 5, blockSize: 4}),
      compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize: 64}),
      createBatchedExecutor(plan, 3),
      createBatchedExecutor(plan, 64),
    ].map(runner => {
      const output = new Float32Array(count * outputs.length)
      runner.runShared(sharedSource)
      runner.runInstances(instanceSources, count, output)
      return output
    })
    for (let instance = 0; instance < count; instance++) {
      const executor = circuit.evaluateTensor(instanceSourceTable(plan, sharedSource, instanceSources, instance))
      outputs.forEach((wire, output) => {
        for (const result of results) {
          if (!sameFloat(result[instance * outputs.length + output]!, executor[wire]!)) {
            throw new Error(`seed ${seed} instance ${instance} output wire ${wire}: backend ${result[instance * outputs.length + output]}, executor ${executor[wire]}`)
          }
        }
      })
    }
  }
})

test('candidate-gallery over the 256×256 grid of viewport widths and heights matches the reference per viewport', () => {
  const workload = createCandidateGridWorkload()
  const {circuit, plan, program} = workload
  const sharedSource = workload.sharedSources[0]!
  // Every 31st viewport, which walks across columns as rows advance, plus the last one.
  const sampled = [...Array.from({length: Math.ceil(workload.count / 31)}, (_, index) => index * 31), workload.count - 1]
  const references = sampled.map(instance => circuit.evaluateReference(instanceSourceTable(plan, sharedSource, workload.instanceSources, instance)))
  let compared = 0
  for (const runner of [compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize: 1024}), createBatchedExecutor(plan, 1024)]) {
    const result = new Float32Array(workload.count * plan.outputs.length)
    runner.runShared(sharedSource)
    runner.runInstances(workload.instanceSources, workload.count, result)
    sampled.forEach((instance, index) => {
      plan.outputs.forEach((position, output) => {
        const expected = references[index]![program.wireOrder[position]!]!
        const actual = result[instance * plan.outputs.length + output]!
        if (!sameFloat(actual, expected)) throw new Error(`viewport ${instance} output ${output}: backend ${actual}, reference ${expected}`)
        compared++
      })
    })
  }
  expect(compared).toBeGreaterThan(100_000)
})

test('candidate-gallery over viewport widths hoists height-only work and matches the reference per width', () => {
  const machine = createCandidateGalleryMachine()
  const {circuit, output} = machine
  machine.source[candidateSourceField.viewportHeight] = 800
  const outputs = [...output.selectedLayout, ...output.scores, ...output.thumbnails, ...output.hero, output.heroPresent]
  const program = circuit.compileTensorProgram(outputs)
  const plan = planInstances(program, [candidateSourceField.viewportWidth], outputs)
  expect(plan.counts.sharedRows).toBeGreaterThan(10)
  const count = 64
  const widths = Float32Array.from({length: count}, (_, index) => 320 + index * 23)
  for (const runner of [compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize: 32}), createBatchedExecutor(plan, 32)]) {
    const result = new Float32Array(count * outputs.length)
    runner.runShared(machine.source)
    runner.runInstances(widths, count, result)
    for (let instance = 0; instance < count; instance++) {
      const reference = circuit.evaluateReference(instanceSourceTable(plan, machine.source, widths, instance))
      outputs.forEach((wire, index) => {
        expect(sameFloat(result[instance * outputs.length + index]!, reference[wire]!)).toBe(true)
      })
    }
  }
})
