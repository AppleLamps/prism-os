// Heavy measurements for the README. Run from the repository root:
//   bun lab/ui-exploration/codegen/report.ts            everything, writes results.json
//   bun lab/ui-exploration/codegen/report.ts cold <variant>   one fresh-process cold run (used internally)
//   bun lab/ui-exploration/codegen/report.ts warm <variant>   one fresh-process warm run (used internally)
// Timings are medians on a shared, busy machine: treat them as rough.
// Variants: executor, generated:<rowsPerFunction>, generated:monolithic.
import {createWindowManagerMachine} from './window-manager-copy.ts'
import {compileScalarProgram, type FroundAccess} from './codegen.ts'
import {compileInstanceProgram, createBatchedExecutor, instanceSourceTable} from './instance.ts'
import {applyInteraction, createHandwiredOSMachine, interactionFrameTime} from './handwired-os-machine.ts'
import {lifeCalendarSource, referenceLifeCalendar} from './life-calendar.ts'
import {
  createCandidateGridWorkload,
  createCandidateWidthWorkload,
  createLifeCalendarWorkload,
  createOwnershipWorkload,
  createShapesWorkload,
  sessionHandwiredOSSource,
  type Workload,
} from './workloads.ts'

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[values.length >> 1]!
}

function round(value: number, digits = 3) {
  return Number(value.toFixed(digits))
}

// Warm for a wall-clock budget so large functions reach the optimizing tiers,
// then take the median of repeated timed batches.
function warmMicroseconds(run: () => void, warmMilliseconds: number, batchMilliseconds = 60, batches = 7) {
  const warmStart = performance.now()
  let warmRuns = 0
  while (performance.now() - warmStart < warmMilliseconds || warmRuns < 3) {
    run()
    warmRuns++
  }
  const probeStart = Bun.nanoseconds()
  for (let index = 0; index < 5; index++) run()
  const once = Math.max(1, (Bun.nanoseconds() - probeStart) / 5)
  const iterations = Math.max(1, Math.round(batchMilliseconds * 1e6 / once))
  const samples: number[] = []
  for (let batch = 0; batch < batches; batch++) {
    const start = Bun.nanoseconds()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((Bun.nanoseconds() - start) / iterations / 1000)
  }
  return median(samples)
}

function parseVariant(variant: string) {
  if (variant === 'executor') return {evaluator: 'executor' as const, rowsPerFunction: 0}
  const [, rows] = variant.split(':')
  return {evaluator: 'generated' as const, rowsPerFunction: rows === 'monolithic' ? Number.POSITIVE_INFINITY : Number(rows)}
}

function createSessionMachine(variant: string, validate = false, froundAccess?: FroundAccess) {
  const {evaluator, rowsPerFunction} = parseVariant(variant)
  return createHandwiredOSMachine({evaluator, validate, rowsPerFunction, ...(froundAccess === undefined ? {} : {froundAccess})})
}

// ----- Fresh-process runs -----

function coldRun(variant: string) {
  const start = performance.now()
  const machine = createSessionMachine(variant)
  const constructMilliseconds = performance.now() - start
  const frames: number[] = []
  for (let frame = 0; frame < 3000; frame++) {
    applyInteraction(machine, frame % 240)
    const frameStart = Bun.nanoseconds()
    machine.step(1280, 800, interactionFrameTime(frame))
    frames.push((Bun.nanoseconds() - frameStart) / 1000)
  }
  return {
    variant,
    constructMilliseconds: round(constructMilliseconds, 1),
    buildAndCompileMilliseconds: round(machine.cold.buildAndCompileMilliseconds, 1),
    generateMilliseconds: round(machine.cold.generateMilliseconds, 1),
    newFunctionMilliseconds: round(machine.cold.compileMilliseconds, 1),
    sourceKilobytes: round(machine.cold.sourceBytes / 1000, 1),
    functionCount: machine.cold.functionCount,
    firstFrameMicroseconds: round(frames[0]!, 1),
    frames2to10MedianMicroseconds: round(median(frames.slice(1, 10)), 1),
    frames11to100MedianMicroseconds: round(median(frames.slice(10, 100)), 2),
    frames101to1000MedianMicroseconds: round(median(frames.slice(100, 1000)), 2),
    frames1001to3000MedianMicroseconds: round(median(frames.slice(1000)), 2),
    totalMillisecondsFor3000Frames: round(frames.reduce((total, value) => total + value, 0) / 1000, 1),
  }
}

function warmRun(variant: string) {
  const machine = createSessionMachine(variant)
  let frame = 0
  const microseconds = warmMicroseconds(() => {
    applyInteraction(machine, frame % 240)
    machine.step(1280, 800, interactionFrameTime(frame))
    frame++
  }, 2500)
  return {variant, warmFrameMicroseconds: round(microseconds)}
}

function child(mode: 'cold' | 'warm', variant: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, mode, variant],
    env: {...process.env, ...env},
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const text = result.stdout.toString().trim()
  if (result.exitCode !== 0 || text === '') throw new Error(`child ${mode} ${variant} failed: ${result.stderr.toString()}`)
  return JSON.parse(text.split('\n').at(-1)!)
}

// ----- Instance workloads -----

function measureWorkload(workload: Workload) {
  const {plan, count, circuit, program} = workload
  const shared = workload.sharedSources[0]!
  const outputs = new Float32Array(count * plan.outputs.length)
  const generated = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 1024})
  const batched = createBatchedExecutor(plan, 1024)
  const runAll = (runner: typeof generated) => () => {
    runner.runShared(shared)
    runner.runInstances(workload.instanceSources, count, outputs)
  }
  const generatedMicroseconds = warmMicroseconds(runAll(generated), 1500, 200, 5)
  const batchedMicroseconds = warmMicroseconds(runAll(batched), 1500, 200, 5)
  // Per-instance baselines evaluate the whole circuit per instance, shared part
  // included, on a slice of the instances.
  const sliceCount = Math.min(count, 2048)
  const tables = Array.from({length: sliceCount}, (_, instance) => instanceSourceTable(plan, shared, workload.instanceSources, instance))
  const executor = circuit.createTensorEvaluator([...program.roots])
  const executorMicroseconds = warmMicroseconds(() => {
    for (const table of tables) executor(table)
  }, 1500, 200, 5)
  const scalar = compileScalarProgram(program, {rowsPerFunction: 128})
  const scalarMicroseconds = warmMicroseconds(() => {
    for (const table of tables) scalar.run(table)
  }, 1500, 200, 5)
  return {
    workload: workload.name,
    instances: count,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    ...plan.counts,
    nanosecondsPerInstance: {
      executorPerInstance: round(executorMicroseconds * 1000 / sliceCount, 1),
      generatedPerInstance: round(scalarMicroseconds * 1000 / sliceCount, 1),
      batchedExecutor: round(batchedMicroseconds * 1000 / count, 1),
      generatedInstanceLoop: round(generatedMicroseconds * 1000 / count, 1),
    },
    millisecondsForAllInstances: {
      batchedExecutor: round(batchedMicroseconds / 1000, 2),
      generatedInstanceLoop: round(generatedMicroseconds / 1000, 2),
    },
  }
}

function blockSizeSweep(workload: Workload) {
  const shared = workload.sharedSources[0]!
  const outputs = new Float32Array(workload.count * workload.plan.outputs.length)
  const rows: Record<string, unknown>[] = []
  for (const blockSize of [1, 16, 256, 1024, 4096, 16_384]) {
    for (const [label, runner] of [
      ['generated instance loop', compileInstanceProgram(workload.plan, {rowsPerFunction: 128, blockSize})],
      ['batched executor', createBatchedExecutor(workload.plan, blockSize)],
    ] as const) {
      const microseconds = warmMicroseconds(() => {
        runner.runShared(shared)
        runner.runInstances(workload.instanceSources, workload.count, outputs)
      }, 1000, 300, 3)
      rows.push({backend: label, blockSize, nanosecondsPerInstance: round(microseconds * 1000 / workload.count, 1)})
    }
  }
  return rows
}

// The same viewport sweep as phase one's life-grid.ts: widths 320..3840 step 3,
// heights 320..2160 step 11, skipping column counts above the capacity.
function lifeSizingSweep() {
  const workload = createLifeCalendarWorkload()
  const runner = compileInstanceProgram(workload.plan, {rowsPerFunction: 128, blockSize: 16})
  const countXPosition = sharedPosition(workload, 'countX')
  const countYPosition = sharedPosition(workload, 'countY')
  let viewports = 0
  let mismatches = 0
  for (let windowWidth = 320; windowWidth <= 3840; windowWidth += 3) {
    for (let windowHeight = 320; windowHeight <= 2160; windowHeight += 11) {
      const reference = referenceLifeCalendar(windowWidth, windowHeight, 0, 0, 0)
      if (reference.countX / 7 > 140) continue
      runner.runShared(lifeCalendarSource(windowWidth, windowHeight, 0, 0, 0))
      viewports++
      if (runner.shared[countXPosition] !== reference.countX || runner.shared[countYPosition] !== reference.countY) mismatches++
    }
  }
  return {viewports, countMismatches: mismatches}
}

// Shared outputs of the life-calendar circuit sit after the per-cell outputs in
// the root list, in the order of createLifeCalendarCircuit's `shared` object.
function sharedPosition(workload: Workload, name: 'countX' | 'countY') {
  const perCellOutputs = workload.plan.outputs.length
  const index = perCellOutputs + (name === 'countX' ? 0 : 1)
  return workload.plan.flat.positionOfWire[workload.program.roots[index]!]!
}

// ----- Main -----

const mode = process.argv[2]
if (mode === 'cold') {
  console.log(JSON.stringify(coldRun(process.argv[3]!)))
} else if (mode === 'warm') {
  console.log(JSON.stringify(warmRun(process.argv[3]!)))
} else {
  const results: Record<string, unknown> = {bun: Bun.version, note: 'rough medians on a shared machine'}
  const log = async (label: string, value: unknown) => {
    results[label] = value
    console.log(label, JSON.stringify(value, null, 1))
    await Bun.write(new URL('./results.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`)
  }

  // Warm evaluation cost of the HandwiredOS program alone, by granularity.
  const production = createWindowManagerMachine()
  const program = production.tensorProgram
  const sessionSource = sessionHandwiredOSSource()
  const executor = production.circuit.createTensorEvaluator([...program.roots])
  const evaluation: Record<string, unknown> = {
    'executor, reusable evaluator': round(warmMicroseconds(() => executor(sessionSource), 2500)),
  }
  for (const rowsPerFunction of [16, 64, 128, 256, 512, 1024, Number.POSITIVE_INFINITY]) {
    for (const froundAccess of (rowsPerFunction === 128 ? ['closure', 'Math.fround'] : ['closure']) as FroundAccess[]) {
      const generated = compileScalarProgram(program, {rowsPerFunction, froundAccess})
      const label = `generated, ${Number.isFinite(rowsPerFunction) ? `${rowsPerFunction} rows per function` : 'one function'}${froundAccess === 'Math.fround' ? ', Math.fround called directly' : ''}`
      evaluation[label] = {
        functions: generated.functions.length,
        sourceKilobytes: round(generated.sourceBytes / 1000, 1),
        microseconds: round(warmMicroseconds(() => generated.run(sessionSource), 2500)),
      }
    }
  }
  await log('HandwiredOS evaluation, warm µs per evaluation', evaluation)

  // Frame loop, warm, in fresh processes.
  const frameLoop: Record<string, unknown> = {}
  const productionMachine = createWindowManagerMachine()
  let productionFrame = 0
  frameLoop['production machine.step (validation, evaluateTensor, writeback)'] = round(warmMicroseconds(() => {
    applyInteraction(productionMachine, productionFrame % 240)
    productionMachine.step(1280, 800, interactionFrameTime(productionFrame))
    productionFrame++
  }, 2500))
  for (const [label, variant, validate] of [
    ['copy, executor, no validation', 'executor', false],
    ['copy, generated 128 rows, no validation', 'generated:128', false],
    ['copy, generated 128 rows, validation', 'generated:128', true],
  ] as const) {
    const machine = createSessionMachine(variant, validate)
    let frame = 0
    frameLoop[label] = round(warmMicroseconds(() => {
      applyInteraction(machine, frame % 240)
      machine.step(1280, 800, interactionFrameTime(frame))
      frame++
    }, 2500))
  }
  await log('HandwiredOS frame loop, warm µs per frame', frameLoop)

  await log('HandwiredOS cold start, fresh processes', ['executor', 'generated:64', 'generated:128', 'generated:512', 'generated:monolithic'].map(variant => child('cold', variant)))
  await log('JavaScriptCore size limits, warm µs per frame in fresh processes', {
    'generated:128, default options': child('warm', 'generated:128').warmFrameMicroseconds,
    'generated:1024, default options': child('warm', 'generated:1024').warmFrameMicroseconds,
    'generated:monolithic, default options': child('warm', 'generated:monolithic').warmFrameMicroseconds,
    'generated:monolithic, BUN_JSC_maximumOptimizationCandidateBytecodeCost=100000000': child('warm', 'generated:monolithic', {BUN_JSC_maximumOptimizationCandidateBytecodeCost: '100000000'}).warmFrameMicroseconds,
    'generated:monolithic, that plus BUN_JSC_maximumFTLCandidateBytecodeCost=100000000': child('warm', 'generated:monolithic', {BUN_JSC_maximumOptimizationCandidateBytecodeCost: '100000000', BUN_JSC_maximumFTLCandidateBytecodeCost: '100000000'}).warmFrameMicroseconds,
  })

  await log('instance workloads', [
    createOwnershipWorkload(sessionSource),
    createLifeCalendarWorkload(),
    createCandidateWidthWorkload(),
    createCandidateGridWorkload(),
    createShapesWorkload(),
    createShapesWorkload(560, 360, 64),
  ].map(measureWorkload))
  await log('block size sweep, ownership map at 320×200', blockSizeSweep(createOwnershipWorkload(sessionSource, 320, 200)))
  await log('life-calendar sizing sweep', lifeSizingSweep())
}
