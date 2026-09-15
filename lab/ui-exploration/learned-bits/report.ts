// Heavy measurements. Run from the repo root:
//   bun lab/ui-exploration/learned-bits/report.ts [section...]
// Sections: authored, ladder, variants, sharing, coverage, clamp-initialization,
// covering-gates. Each merges into report-output.json (under authored, ladder,
// variants, sharing, coverage, clampInitialization, coveringGates). With no
// section named, every section runs.
// Experiments run as child processes (`report.ts run '<json>'`), several at a
// time; progress lines go to $LEARNED_BITS_LOG when set.

import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {authoredDrag, authoredFirstActive, authoredRectangleHit, authoredTab, certifyCircuit, measureProgram} from './compile.ts'
import {runExperiment, type ExperimentConfig, type ExperimentResult} from './experiment.ts'
import {neededInputs, wiringCoverage} from './inspect.ts'
import {createNetwork, createTrainer, defaultNetworkOptions, type NetworkOptions, type TrainOptions} from './network.ts'
import {createTask, type Task} from './tasks.ts'

const outputPath = new URL('./report-output.json', import.meta.url).pathname
const logPath = process.env['LEARNED_BITS_LOG'] ?? null
const concurrency = Number(process.env['LEARNED_BITS_CONCURRENCY'] ?? 10)

function log(line: string) {
  if (logPath !== null) appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
}

function merge(section: string, value: unknown) {
  const existing = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : {}
  existing[section] = value
  writeFileSync(outputPath, `${JSON.stringify(existing, null, 2)}\n`)
}

async function runPool(configs: ExperimentConfig[]): Promise<ExperimentResult[]> {
  const results: ExperimentResult[] = new Array(configs.length)
  let nextIndex = 0
  let finished = 0
  const worker = async () => {
    while (nextIndex < configs.length) {
      const index = nextIndex++
      const config = configs[index]!
      const child = Bun.spawn(['bun', import.meta.path, 'run', JSON.stringify(config)], {stdout: 'pipe', stderr: 'pipe'})
      const [text, errorText] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      await child.exited
      const line = text.trim().split('\n').at(-1) ?? ''
      try {
        results[index] = JSON.parse(line)
      } catch {
        throw new Error(`experiment ${config.label} failed: ${errorText}`)
      }
      finished++
      const result = results[index]!
      log(`${finished}/${configs.length} ${config.label} seed ${config.seed}: all ${result.allExact}/${result.caseCount}, held out ${result.heldOutExact}/${result.heldOutCount}, ${result.seconds}s`)
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, configs.length)}, worker))
  return results
}

// ---------------------------------------------------------------------------
// Ladder settings. Counting networks use the widths below; gate networks use
// twice the width and twice the group size, so both have the same logit count.

type LadderEntry = {task: string, hiddenWidths: number[], groupSize: number, steps: number, batchSize: number}

const ladder: LadderEntry[] = [
  {task: 'first-active-8', hiddenWidths: [32, 32], groupSize: 2, steps: 2000, batchSize: 0},
  {task: 'tab-4', hiddenWidths: [48, 48, 48], groupSize: 2, steps: 2000, batchSize: 0},
  {task: 'tab-6', hiddenWidths: [64, 64, 64], groupSize: 4, steps: 2000, batchSize: 0},
  {task: 'tab-8', hiddenWidths: [96, 96, 96], groupSize: 4, steps: 2000, batchSize: 512},
  {task: 'tab-12', hiddenWidths: [128, 128, 128, 128], groupSize: 4, steps: 2000, batchSize: 512},
  {task: 'rectangle-hit', hiddenWidths: [48, 48, 48], groupSize: 8, steps: 2000, batchSize: 512},
  {task: 'click-or-drag', hiddenWidths: [48, 48, 48], groupSize: 8, steps: 2000, batchSize: 0},
  {task: 'menu-slot', hiddenWidths: [96, 96, 96], groupSize: 2, steps: 2000, batchSize: 512},
]

const seeds = [1, 2, 3]

function ladderEntry(task: string) {
  return ladder.find(candidate => candidate.task === task)!
}

function configFor(entry: LadderEntry, kind: 'count' | 'gate', seed: number, label: string, network: Partial<NetworkOptions> = {}, train: Partial<TrainOptions> = {}, trainFraction = 0.6): ExperimentConfig {
  const scale = kind === 'gate' ? 2 : 1
  return {
    label,
    task: entry.task,
    seed,
    trainFraction,
    inspect: true,
    network: {kind, hiddenWidths: entry.hiddenWidths.map(width => width * scale), groupSize: entry.groupSize * scale, ...network},
    train: {steps: entry.steps, batchSize: entry.batchSize, learningRate: kind === 'gate' ? 0.05 : 0.1, ...train},
  }
}

function summarize(results: ExperimentResult[]) {
  const groups = new Map<string, ExperimentResult[]>()
  for (const result of results) {
    const key = `${result.label}|${result.task}|${result.kind}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return [...groups.values()].map(group => {
    const first = group[0]!
    return {
      label: first.label,
      task: first.task,
      kind: first.kind,
      cases: first.caseCount,
      logits: first.logits,
      seeds: group.length,
      learnedExactly: group.filter(result => result.learnedExactly).length,
      allExact: group.map(result => result.allExact),
      trainExact: group.map(result => `${result.trainExact}/${result.trainCount}`),
      heldOutExact: group.map(result => (result.heldOutCount === null ? '-' : `${result.heldOutExact}/${result.heldOutCount}`)),
      coveredOutputs: group.map(result => result.coveredOutputs),
      wiringRedraws: group.map(result => result.wiringRedraws),
      softLoss: group.map(result => result.softLoss),
      liveOperations: group.map(result => result.circuit.liveOperations),
      circuitLayers: group.map(result => result.circuit.layers),
      circuitAgreesWithNetlist: group.every(result => result.circuitAgreesWithNetlist === result.caseCount),
      seconds: group.map(result => result.seconds),
    }
  })
}

function ladderConfigs() {
  return ladder.flatMap(entry => (['count', 'gate'] as const).flatMap(kind => seeds.map(seed => configFor(entry, kind, seed, 'base'))))
}

async function ladderSection() {
  const results = await runPool(ladderConfigs())
  merge('ladder', {settings: ladder, seeds, summary: summarize(results), runs: results})
}

const variantTasks = ['tab-4', 'click-or-drag', 'first-active-8']
const variants: {label: string, kinds: ('count' | 'gate')[], network?: Partial<NetworkOptions>, train?: Partial<TrainOptions>, trainFraction?: number}[] = [
  {label: 'base', kinds: ['count', 'gate']},
  {label: 'fit every case', kinds: ['count', 'gate'], trainFraction: 1},
  {label: 'prefix wiring', kinds: ['count', 'gate'], network: {wiring: 'prefix'}},
  {label: 'prefix wiring, zero bias 3', kinds: ['count'], network: {wiring: 'prefix', zeroBias: 3}},
  {label: 'read every earlier layer', kinds: ['count', 'gate'], network: {pool: 'all-earlier'}},
  {label: 'temperature 1 to 0.1', kinds: ['count', 'gate'], train: {temperatureStart: 1, temperatureEnd: 0.1}},
  {label: 'no complements', kinds: ['count', 'gate'], network: {complements: false}},
  {label: 'cross-entropy loss', kinds: ['count', 'gate'], train: {loss: 'cross-entropy'}},
  {label: 'clamp relaxation', kinds: ['count'], network: {relaxation: 'clamp'}},
  {label: 'normal relaxation, 24 candidates, every earlier layer, zero bias 3', kinds: ['count'], network: {relaxation: 'normal', candidates: 24, pool: 'all-earlier', zeroBias: 3}},
]

function variantConfigs() {
  return variantTasks.flatMap(taskName => variants.flatMap(variant => variant.kinds.flatMap(kind => seeds.map(seed => configFor(ladderEntry(taskName), kind, seed, variant.label, variant.network ?? {}, variant.train ?? {}, variant.trainFraction ?? 0.6)))))
}

async function variantsSection() {
  const results = await runPool(variantConfigs())
  merge('variants', {tasks: variantTasks, variants, seeds, summary: summarize(results), runs: results.map(result => ({...result, inspection: null}))})
}

// Units shared across positions (see network.ts). Counting units here read
// every relative reference (candidates = 0) through the normal relaxation;
// gates keep randomly drawn 2-wire templates.
const sharedCount: Partial<NetworkOptions> = {kind: 'count', sharing: true, candidates: 0, relaxation: 'normal', zeroBias: 3}
const sharingRuns: {label: string, task: string, network: Partial<NetworkOptions>, train: Partial<TrainOptions>, trainFraction?: number}[] = [
  {label: 'shared counting unit, no hidden layer', task: 'first-active-8', network: {...sharedCount, hiddenWidths: [], groupSize: 1}, train: {steps: 1000, learningRate: 0.1}},
  {label: 'shared counting unit, no hidden layer, expectation relaxation', task: 'first-active-8', network: {...sharedCount, relaxation: 'expectation', hiddenWidths: [], groupSize: 1}, train: {steps: 1000, learningRate: 0.1}},
  {label: 'shared gates, 2 layers', task: 'first-active-8', network: {kind: 'gate', sharing: true, hiddenWidths: [32, 32], groupSize: 2}, train: {steps: 2000, learningRate: 0.05}},
  {label: 'shared counting units, 3 layers', task: 'tab-4', network: {...sharedCount, hiddenWidths: [16, 16, 16], groupSize: 2}, train: {steps: 2000, learningRate: 0.1}},
  {label: 'shared counting units, 5 layers, zero padding, every earlier layer', task: 'tab-4', network: {...sharedCount, padding: 'zero', pool: 'all-earlier', hiddenWidths: [16, 16, 16, 16, 16], groupSize: 2}, train: {steps: 3000, learningRate: 0.1}},
  {label: 'shared counting units, 5 layers, zero padding, every earlier layer, fit every case', task: 'tab-4', trainFraction: 1, network: {...sharedCount, padding: 'zero', pool: 'all-earlier', hiddenWidths: [16, 16, 16, 16, 16], groupSize: 2}, train: {steps: 3000, learningRate: 0.1}},
  {label: 'shared gates, 3 layers', task: 'tab-4', network: {kind: 'gate', sharing: true, hiddenWidths: [32, 32, 32], groupSize: 4}, train: {steps: 2000, learningRate: 0.05}},
  {label: 'shared counting units, 3 layers, every earlier layer', task: 'tab-6', network: {...sharedCount, pool: 'all-earlier', hiddenWidths: [24, 24, 24], groupSize: 2}, train: {steps: 2000, learningRate: 0.1}},
  {label: 'shared gates, 3 layers', task: 'tab-6', network: {kind: 'gate', sharing: true, hiddenWidths: [48, 48, 48], groupSize: 4}, train: {steps: 2000, learningRate: 0.05}},
  {label: 'shared counting units, 3 layers, every earlier layer, batches of 1024', task: 'tab-8', network: {...sharedCount, pool: 'all-earlier', hiddenWidths: [32, 32, 32], groupSize: 2}, train: {steps: 2000, learningRate: 0.1, batchSize: 1024}},
  {label: 'shared counting units, 3 layers, every earlier layer, batches of 1024', task: 'tab-12', network: {...sharedCount, pool: 'all-earlier', hiddenWidths: [48, 48, 48], groupSize: 2}, train: {steps: 2000, learningRate: 0.1, batchSize: 1024}},
]

function sharingConfigs(): ExperimentConfig[] {
  return sharingRuns.flatMap(run => seeds.map(seed => ({label: run.label, task: run.task, seed, trainFraction: run.trainFraction ?? 0.6, inspect: true, network: run.network, train: run.train})))
}

async function sharingSection() {
  const results = await runPool(sharingConfigs())
  merge('sharing', {runs: sharingRuns, seeds, summary: summarize(results), results})
}

// ---------------------------------------------------------------------------
// Wiring coverage: for every configuration of the ladder, variants, and sharing
// sections, how many output bits the drawn wiring lets read every input they
// need (inspect.ts's wiringCoverage). Wiring doesn't change during training, so
// this builds the networks without training them.

const taskCache = new Map<string, {task: Task, needed: Set<number>[]}>()
function cachedTask(name: string) {
  let entry = taskCache.get(name)
  if (entry === undefined) {
    const task = createTask(name)
    entry = {task, needed: neededInputs(task)}
    taskCache.set(name, entry)
  }
  return entry
}

function coverageSection() {
  const sections = [['ladder', ladderConfigs()], ['variants', variantConfigs()], ['sharing', sharingConfigs()]] as const
  const runs = sections.flatMap(([section, configs]) => configs.map(config => {
    const {task, needed} = cachedTask(config.task)
    const network = createNetwork(task, {...defaultNetworkOptions, ...config.network, seed: config.seed})
    const coverage = wiringCoverage(network, task, needed)
    return {section, label: config.label, task: config.task, kind: network.options.kind, seed: config.seed, coveredOutputs: coverage.coveredOutputs, outputs: coverage.outputCount, missing: coverage.missing.slice(0, 3)}
  }))
  const groups = new Map<string, typeof runs>()
  for (const run of runs) {
    const key = `${run.section}|${run.label}|${run.task}|${run.kind}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const summary = [...groups.values()].map(group => ({section: group[0]!.section, label: group[0]!.label, task: group[0]!.task, kind: group[0]!.kind, outputs: group[0]!.outputs, coveredOutputs: group.map(run => run.coveredOutputs)}))
  merge('coverage', {summary, runs})
}

// ---------------------------------------------------------------------------
// The clamp relaxation at several initial biases toward "+1 on the first
// candidate, threshold 1". With residual bias 2, E[t] starts near 3 and the
// clamp starts saturated; with 6, E[t] starts near 1.07. The expectation
// relaxation at residual bias 6 separates the initialization from the relaxation.

const clampBiases = [2, 4, 6]

function clampInitializationConfigs() {
  return variantTasks.flatMap(taskName => [
    ...clampBiases.flatMap(bias => seeds.map(seed => configFor(ladderEntry(taskName), 'count', seed, `clamp relaxation, residual bias ${bias}`, {relaxation: 'clamp', residualBias: bias}))),
    ...seeds.map(seed => configFor(ladderEntry(taskName), 'count', seed, 'expectation relaxation, residual bias 6', {residualBias: 6})),
  ]).map(config => ({...config, inspect: false}))
}

// The share of logits whose gradient over every case is nonzero at initialization.
function initialGradientShare(config: ExperimentConfig) {
  const {task} = cachedTask(config.task)
  const network = createNetwork(task, {...defaultNetworkOptions, ...config.network, seed: config.seed})
  const cases = Int32Array.from({length: task.caseCount}, (_, index) => index)
  const trainer = createTrainer(network, task, cases.length)
  trainer.load(cases, 0, cases.length)
  trainer.forward(1)
  trainer.backward(1)
  let nonzero = 0
  let total = 0
  for (const gradients of trainer.logitGradients) {
    for (const value of gradients) {
      total++
      if (value !== 0) nonzero++
    }
  }
  return nonzero / total
}

async function clampInitializationSection() {
  const configs = clampInitializationConfigs()
  const initialGradients = configs.filter(config => config.network.relaxation === 'clamp').map(config => ({task: config.task, label: config.label, seed: config.seed, nonzeroGradientShare: Number(initialGradientShare(config).toPrecision(3))}))
  const results = await runPool(configs)
  merge('clampInitialization', {biases: clampBiases, initialGradients, summary: summarize(results), runs: results})
}

// ---------------------------------------------------------------------------
// Gates whose wiring can express the task: every configuration here redraws
// its wiring until every output bit reaches every input it needs. The ladder's
// gate settings, then first-active-8 with deeper ladder gates at the ladder's
// logit count, shared gates with doubling wiring, and a short sweep of learning
// rates and steps; and the sharing section's shared gates on tab-4 and tab-6.

const redrawUntilCovered = 200

function coveringGateConfigs(): ExperimentConfig[] {
  const firstActive = ladderEntry('first-active-8')
  const deepGates: Partial<NetworkOptions> = {hiddenWidths: [32, 32, 32, 32], groupSize: 4}
  const doublingGates: Partial<NetworkOptions> = {kind: 'gate', sharing: true, wiring: 'doubling', hiddenWidths: [64, 64, 64], groupSize: 4}
  const configs: ExperimentConfig[] = [
    ...ladder.flatMap(entry => seeds.map(seed => configFor(entry, 'gate', seed, 'ladder gates, wiring redrawn until covered'))),
    ...[0.6, 1].flatMap(trainFraction => seeds.map(seed => configFor(firstActive, 'gate', seed, `4 hidden layers of 32 gates, wiring redrawn until covered, train fraction ${trainFraction}`, deepGates, {}, trainFraction))),
    ...[0.6, 1].flatMap(trainFraction => seeds.map(seed => configFor(firstActive, 'gate', seed, `shared gates, doubling wiring, 3 hidden layers of 64, wiring redrawn until covered, train fraction ${trainFraction}`, doublingGates, {}, trainFraction))),
    ...[2000, 10000].flatMap(steps => [0.02, 0.05, 0.1, 0.2].flatMap(learningRate => ([['4 hidden layers of 32 gates', deepGates], ['shared gates, doubling wiring', doublingGates]] as const).flatMap(([name, network]) => seeds.map(seed => configFor(firstActive, 'gate', seed, `sweep: ${name}, every case, ${steps} steps, learning rate ${learningRate}`, network, {steps, learningRate}, 1))))),
    ...sharingRuns.filter(run => run.network.kind === 'gate' && run.task !== 'first-active-8').flatMap(run => seeds.map(seed => ({label: `${run.label}, wiring redrawn until covered`, task: run.task, seed, trainFraction: 0.6, inspect: false, network: run.network, train: run.train}))),
  ]
  return configs.map(config => ({...config, inspect: false, redrawUntilCovered}))
}

async function coveringGatesSection() {
  const results = await runPool(coveringGateConfigs())
  merge('coveringGates', {redrawUntilCovered, summary: summarize(results), runs: results})
}

function authoredSection() {
  const rows: unknown[] = []
  for (const name of ['tab-4', 'tab-6', 'tab-8', 'tab-12']) {
    const task = createTask(name)
    for (const form of ['input-kit', 'counting'] as const) {
      const {circuit, roots} = authoredTab(task, form)
      const certified = certifyCircuit(circuit, roots, task)
      rows.push({task: name, form, ...measureProgram(circuit, roots), exact: certified.exact, cases: certified.total})
    }
  }
  for (const [name, build] of [['first-active-8', authoredFirstActive], ['rectangle-hit', authoredRectangleHit], ['click-or-drag', authoredDrag]] as const) {
    const task = createTask(name)
    const {circuit, roots} = build(task)
    const certified = certifyCircuit(circuit, roots, task)
    rows.push({task: name, form: 'counting', ...measureProgram(circuit, roots), exact: certified.exact, cases: certified.total})
  }
  const tasks = ['first-active-8', 'tab-4', 'tab-6', 'tab-8', 'tab-12', 'rectangle-hit', 'click-or-drag', 'menu-slot'].map(name => {
    const task = createTask(name)
    return {task: name, cases: task.caseCount, inputs: task.inputCount, outputs: task.outputCount, predicates: task.predicates().length}
  })
  merge('authored', {tasks, constructions: rows})
}

if (process.argv[2] === 'run') {
  const config = JSON.parse(process.argv[3] ?? '{}') as ExperimentConfig
  console.log(JSON.stringify(runExperiment(config)))
} else {
  const sections = process.argv.slice(2)
  const all = sections.length === 0
  if (all || sections.includes('authored')) authoredSection()
  if (all || sections.includes('ladder')) await ladderSection()
  if (all || sections.includes('variants')) await variantsSection()
  if (all || sections.includes('sharing')) await sharingSection()
  if (all || sections.includes('coverage')) coverageSection()
  if (all || sections.includes('clamp-initialization')) await clampInitializationSection()
  if (all || sections.includes('covering-gates')) await coveringGatesSection()
}
