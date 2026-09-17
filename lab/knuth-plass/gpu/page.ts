// The GPU measurement page. run.ts serves it, opens it in headless Chrome, and writes what it posts to /result. Modes,
// from /config:
// - 'main': for each size, n break points × W × P paragraphs, and each kernel: per-evaluation times with each input, the
//   compute pass from timestamp queries, one pass per stage, and reference.ts's knuthPlass and plan.ts's knuthPlassTyped
//   in this page. Consecutive evaluations alternate between two widths, and every readback is compared with knuthPlass.
// - 'check': random paragraphs, e.g. with equal totals, boxes wider than the column, and totals past 2^22, at many break
//   counts and windows, with every input, compared with knuthPlass: the total, every pointer, the breaks and every state.
import {createRandom, defaultBoxes, infeasible, randomParagraph, timingBoxes} from '../paragraph.ts'
import {knuthPlass} from '../reference.ts'
import {type Evaluation, type Input, type TimestampMode, createGpuTree} from './kernels.ts'
import {type Kernel, batchParagraphs, breaksOf, expectedOut, expectedStates, gpuPlan, hasTie, layOutTyped, writeLineCosts, writePositions} from './plan.ts'

export type Size = {breaks: number, window: number, paragraphs: number}
export type PageConfig = {
  mode: 'main' | 'check'
  sizes: Size[]
  kernels: Kernel[]
  inputs: Input[]
  // Consecutive evaluations alternate between these two widths.
  widths: [number, number]
  // Goes into every shader's source, see kernels.ts. A salt that no earlier run used gives cold compile times.
  shaderSalt: number
  warmupMs: number
  sampleMs: number
  minimumSamples: number
  maximumSamples: number
  // Sizes whose matrices need more are skipped.
  maxMatrixMegabytes: number
  checkWindows: number[]
  checkBreaks: number[]
}

const round = (value: number) => Math.round(value * 1000) / 1000
function summary(values: readonly (number | undefined)[]) {
  const sorted = values.filter(value => value !== undefined).sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  return {count: sorted.length, median: round(at(0.5)), p10: round(at(0.1)), p90: round(at(0.9)), min: round(sorted[0]!), max: round(sorted.at(-1)!)}
}

// crossOriginIsolated is true when run.ts's headers took effect, and performance.now() reads in steps of 5 µs.
const report: Record<string, unknown> = {startedAt: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated: globalThis.crossOriginIsolated}
const logLines: string[] = []
async function post(done: boolean) {
  await fetch('/result', {method: 'POST', body: JSON.stringify({...report, logLines, done})})
}
function log(line: string) {
  console.log(line)
  logLines.push(`${round(performance.now())} ms: ${line}`)
  document.querySelector('#log')!.textContent = logLines.join('\n')
}

const config = await (await fetch('/config')).json() as PageConfig
report['config'] = config

// Evaluates until at least warmupMs and 3 evaluations have passed, then samples until sampleMs and minimumSamples have
// passed, or maximumSamples.
async function sample<Record>(evaluateOnce: () => Promise<Record>, settings: Pick<PageConfig, 'warmupMs' | 'sampleMs' | 'minimumSamples' | 'maximumSamples'> = config) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 || performance.now() - warmStarted < settings.warmupMs; warm++) await evaluateOnce()
  const records: Record[] = []
  const started = performance.now()
  while (records.length < settings.maximumSamples && (records.length < settings.minimumSamples || performance.now() - started < settings.sampleMs)) records.push(await evaluateOnce())
  return records
}
const passSettings = {warmupMs: 200, sampleMs: 600, minimumSamples: 7, maximumSamples: 60}

const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no WebGPU adapter')
const hasTimestamps = adapter.features.has('timestamp-query')
const device = await adapter.requestDevice({
  requiredFeatures: hasTimestamps ? ['timestamp-query'] : [],
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupSizeY: adapter.limits.maxComputeWorkgroupSizeY,
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
  },
})
void device.lost.then(info => {
  report['deviceLost'] = `${info.reason}: ${info.message}`
  void post(true)
})
device.addEventListener('uncapturederror', event => {
  report['uncapturedError'] = event.error.message
  void post(true)
})
report['adapter'] = {
  info: {vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description},
  hasTimestamps,
  limits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension},
}

const compileTimes: unknown[] = []
const results: unknown[] = []
report['compileTimes'] = compileTimes
report['results'] = results
async function compileTree(kernel: Kernel, window: number) {
  const tree = await createGpuTree(device, kernel, window, config.shaderSalt)
  compileTimes.push({kernel, window, shaderSalt: config.shaderSalt, ...tree.compileTimes})
  log(`${kernel}, W = ${window}: compiled in ${JSON.stringify(tree.compileTimes)}`)
  return tree
}
type GpuTree = Awaited<ReturnType<typeof createGpuTree>>

const mismatchedValues = (values: Uint32Array, expected: Uint32Array) => {
  let mismatched = Math.abs(values.length - expected.length)
  for (let index = 0; index < Math.min(values.length, expected.length); index++) if (values[index] !== expected[index]) mismatched++
  return mismatched
}

// Everything a size needs, shared by both kernels: the paragraphs, the expected readback at each width, and the arrays
// JavaScript writes before an upload.
function setUp({breaks, window, paragraphs: count}: Size) {
  const started = performance.now()
  const paragraphs = batchParagraphs(breaks, count)
  const solutions = config.widths.map(width => paragraphs.map(paragraph => knuthPlass(paragraph, width, window)))
  const expected = solutions.map(list => Uint32Array.from(list.flatMap(solution => expectedOut(solution.costs, solution.predecessors))))
  const widthArrays = config.widths.map(width => new Int32Array(count).fill(width))
  const referenceMs = performance.now() - started
  return {
    paragraphs, solutions, expected, widthArrays, referenceMs,
    lineCosts: new Uint32Array(count * breaks * window),
    positions: new Int32Array(count * 2 * breaks),
    largestCost: solutions.flat().reduce((largest, solution) => solution.costs.reduce((inner, cost) => Math.max(inner, cost), largest), 0),
    lines: solutions.map(list => list.reduce((total, solution) => total + solution.breaks.length, 0)),
  }
}
type Setup = ReturnType<typeof setUp>

type Sample = Evaluation & {jsMs: number}
const summarizeRecords = (records: readonly Sample[]) => ({
  jsMs: summary(records.map(record => record.jsMs)),
  uploadMs: summary(records.map(record => record.uploadMs)),
  encodeAndSubmitMs: summary(records.map(record => record.encodeAndSubmitMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  backtrackMs: summary(records.map(record => record.backtrackMs)),
  totalMs: summary(records.map(record => record.totalMs)),
  totalWithJsMs: summary(records.map(record => record.totalMs + record.jsMs)),
  passMs: summary(records.map(record => record.passMs)),
})

async function measureKernel(tree: GpuTree, kernel: Kernel, size: Size, setup: Setup) {
  const {breaks, window, paragraphs: count} = size
  const planStarted = performance.now()
  const plan = gpuPlan(breaks)
  const planMs = performance.now() - planStarted
  const prepareStarted = performance.now()
  const prepared = await tree.prepare(plan, count)
  const prepareMs = performance.now() - prepareStarted
  const checks = {readbacks: 0, mismatchedValues: 0, breakChecks: 0, mismatchedBreaks: 0}
  let evaluationIndex = 0
  // jsMs is the JavaScript work before the upload: writing the line costs, or copying the positions.
  const evaluateOnce = async (input: Input, timestamps: TimestampMode = 'none'): Promise<Sample> => {
    const widthIndex = evaluationIndex++ % 2
    const widths = setup.widthArrays[widthIndex]!
    const jsStarted = performance.now()
    if (input === 'line-costs') writeLineCosts(setup.paragraphs, widths, window, setup.lineCosts)
    else if (input === 'positions') writePositions(setup.paragraphs, setup.positions)
    const jsMs = performance.now() - jsStarted
    const evaluation = await prepared.evaluate(input === 'line-costs' ? {kind: 'line-costs', lineCosts: setup.lineCosts} : input === 'positions' ? {kind: 'positions', positions: setup.positions, widths} : {kind: 'widths', widths}, {timestamps})
    checks.readbacks++
    checks.mismatchedValues += mismatchedValues(evaluation.out, setup.expected[widthIndex]!)
    if (evaluationIndex <= 4) {
      for (const paragraph of new Set([0, count - 1])) {
        checks.breakChecks++
        if (breaksOf(evaluation.out, paragraph, breaks).join() !== setup.solutions[widthIndex]![paragraph]!.breaks.join()) checks.mismatchedBreaks++
      }
    }
    return {...evaluation, jsMs}
  }
  const firstStarted = performance.now()
  await evaluateOnce('positions')
  const firstEvaluationMs = performance.now() - firstStarted
  const inputs: Record<string, unknown> = {}
  for (const input of config.inputs) {
    const readback = await sample(() => evaluateOnce(input))
    const pass = hasTimestamps ? await sample(() => evaluateOnce(input, 'pass'), passSettings) : []
    inputs[input] = {readback: summarizeRecords(readback), pass: summarizeRecords(pass)}
    await post(false)
  }
  // One compute pass per stage, with the positions input: 1 warm evaluation and 5 samples, and each stage's median.
  let stages: unknown
  if (hasTimestamps) {
    await evaluateOnce('positions', 'stages')
    const records: number[][] = []
    for (let index = 0; index < 5; index++) records.push((await evaluateOnce('positions', 'stages')).stageMs!)
    stages = {
      leavesAndFirstStateMs: summary(records.map(record => record[0]))!.median,
      levels: plan.levels.map(({matrixCount, vectorCount}, index) => ({matrixCount, vectorCount, medianMs: summary(records.map(record => record[index + 1]))!.median})),
      pointersMs: summary(records.map(record => record.at(-1)))!.median,
      sumMs: summary(records.map(record => record.reduce((total, value) => total + value, 0))),
    }
  }
  prepared.destroy()
  return {
    kind: 'gpu', ...size, kernel, levels: plan.levels.length, matrixProducts: plan.matrixTriples.length / 5, vectorProducts: plan.vectorTriples.length / 4,
    matrixMegabytes: prepared.matrixMegabytes, lineCostMegabytes: setup.lineCosts.byteLength / 1e6, positionMegabytes: setup.positions.byteLength / 1e6,
    planMs: round(planMs), prepareMs: round(prepareMs), firstEvaluationMs: round(firstEvaluationMs), inputs, stages, checks,
  }
}

// µs per call of `run` in this page: 300 ms of warmup, then 7 samples of at least 100 ms each.
function timeInPage(run: () => void) {
  const warmUntil = performance.now() + 300
  while (performance.now() < warmUntil) run()
  const samples: number[] = []
  for (let index = 0; index < 7; index++) {
    let iterations = 0
    const started = performance.now()
    do {
      run()
      iterations++
    } while (performance.now() - started < 100)
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  return {median: round(summary(samples)!.median), samples: samples.map(round)}
}

function measureCpuInPage(size: Size, setup: Setup) {
  const {breaks, window, paragraphs: count} = size
  const totals = setup.expected.map(expected => Float64Array.from({length: count}, (_, paragraph) => expected[paragraph * (breaks + 1)]!))
  let referenceIndex = 0
  const reference = timeInPage(() => {
    const widthIndex = referenceIndex++ % 2
    for (let paragraph = 0; paragraph < count; paragraph++) {
      if (knuthPlass(setup.paragraphs[paragraph]!, config.widths[widthIndex]!, window).totalCost !== totals[widthIndex]![paragraph]) throw new Error('the reference changed its total')
    }
  })
  writePositions(setup.paragraphs, setup.positions)
  const costs = new Float64Array(breaks + 1)
  const predecessors = new Int32Array(breaks + 1)
  const breakPoints = new Int32Array(count * breaks)
  const typedTotals = new Float64Array(count)
  let typedIndex = 0
  const typed = timeInPage(() => {
    const widthIndex = typedIndex++ % 2
    const written = layOutTyped(setup.positions, count, breaks, config.widths[widthIndex]!, window, costs, predecessors, breakPoints, typedTotals)
    if (written !== setup.lines[widthIndex]) throw new Error('the typed loop changed its line count')
    for (let paragraph = 0; paragraph < count; paragraph++) if (typedTotals[paragraph] !== totals[widthIndex]![paragraph]) throw new Error('the typed loop changed its total')
  })
  return {kind: 'cpu-in-page', ...size, referenceMicroseconds: reference, typedMicroseconds: typed}
}

async function runMain() {
  const windows = [...new Set(config.sizes.map(size => size.window))]
  for (const window of windows) {
    const trees = new Map<Kernel, GpuTree>()
    for (const kernel of config.kernels) trees.set(kernel, await compileTree(kernel, window))
    for (const size of config.sizes.filter(entry => entry.window === window)) {
      const setup = setUp(size)
      log(`n = ${size.breaks}, W = ${window}, P = ${size.paragraphs}: references in ${round(setup.referenceMs)} ms, largest cost ${setup.largestCost}`)
      for (const kernel of config.kernels) {
        const plan = gpuPlan(size.breaks)
        const matrixMegabytes = size.paragraphs * (size.breaks + plan.productSlots) * window * window * 4 / 1e6
        if (matrixMegabytes > config.maxMatrixMegabytes) {
          results.push({kind: 'gpu', ...size, kernel, skipped: `the matrices would need ${round(matrixMegabytes)} MB`})
          log(`skipped ${kernel} at n = ${size.breaks}, W = ${window}, P = ${size.paragraphs}: ${round(matrixMegabytes)} MB`)
          continue
        }
        const result = await measureKernel(trees.get(kernel)!, kernel, size, setup)
        results.push(result)
        const inputs = result.inputs as Record<string, {readback: ReturnType<typeof summarizeRecords>, pass: ReturnType<typeof summarizeRecords>}>
        log(`${kernel}, n = ${size.breaks}, W = ${window}, P = ${size.paragraphs}: ${config.inputs.map(input => `${input} ${inputs[input]?.readback.totalWithJsMs?.median} ms (pass ${inputs[input]?.pass.passMs?.median})`).join(', ')}, checks ${JSON.stringify(result.checks)}`)
        await post(false)
      }
      const cpu = measureCpuInPage(size, setup)
      results.push(cpu)
      log(`in the page, n = ${size.breaks}, W = ${window}, P = ${size.paragraphs}: reference ${cpu.referenceMicroseconds.median} µs, typed ${cpu.typedMicroseconds.median} µs`)
      await post(false)
    }
  }
}

const tieBoxes = {minimumBox: 1, maximumBox: 4, space: 1, hyphen: 1, hyphenChance: 0.2}
const wideBoxes = {minimumBox: 30, maximumBox: 40, space: 2, hyphen: 3, hyphenChance: 0.1}

// For one break count: batches of paragraphs of one kind each, and one of mixed kinds, each paragraph with its own two
// widths: small boxes at narrow widths, which give equal totals, random boxes at random widths, the timing boxes near
// 300 px, and boxes wider than every width, whose totals pass 2^22 from 1,057 break points.
function checkBatches(breaks: number, random: () => number) {
  type Kind = {boxes: typeof tieBoxes, width: () => number}
  const kinds: Kind[] = [
    {boxes: tieBoxes, width: () => Math.floor(random() * 20)},
    {boxes: defaultBoxes, width: () => Math.floor(random() * 420)},
    {boxes: timingBoxes, width: () => 260 + Math.floor(random() * 100)},
    {boxes: wideBoxes, width: () => Math.floor(random() * 30)},
  ]
  const count = breaks >= 1024 ? 2 : 5
  const batch = (pick: (index: number) => Kind) => {
    const chosen = Array.from({length: count}, (_, index) => pick(index))
    return {paragraphs: chosen.map(kind => randomParagraph(random, breaks, kind.boxes)), widths: chosen.map(kind => [kind.width(), kind.width()] as const)}
  }
  return [...kinds.map(kind => batch(() => kind)), batch(index => kinds[index % kinds.length]!)]
}

async function runChecks() {
  for (const window of config.checkWindows) {
    for (const kernel of config.kernels) {
      const tree = await compileTree(kernel, window)
      for (const breaks of config.checkBreaks) {
        const random = createRandom(breaks * 1_000_003 + window * 101 + (kernel === 'full' ? 1 : 2))
        const totals = {kernel, window, breaks, batches: 0, paragraphs: 0, evaluations: 0, comparedValues: 0, mismatchedValues: 0, mismatchedBreaks: 0, paragraphsWithTies: 0, paragraphsWithTotalsPast2To22: 0, failures: [] as unknown[]}
        const plan = gpuPlan(breaks)
        for (const {paragraphs, widths} of checkBatches(breaks, random)) {
          const prepared = await tree.prepare(plan, paragraphs.length, {readStates: true})
          const solutions = [0, 1].map(which => paragraphs.map((paragraph, index) => knuthPlass(paragraph, widths[index]![which]!, window)))
          const widthArrays = [0, 1].map(which => Int32Array.from(widths.map(pair => pair[which]!)))
          const lineCosts = new Uint32Array(paragraphs.length * breaks * window)
          writeLineCosts(paragraphs, widthArrays[0]!, window, lineCosts)
          const positions = new Int32Array(paragraphs.length * 2 * breaks)
          writePositions(paragraphs, positions)
          const evaluations: [string, number, () => Promise<Evaluation>][] = [
            ['line-costs', 0, () => prepared.evaluate({kind: 'line-costs', lineCosts}, {withStates: true})],
            ['positions', 0, () => prepared.evaluate({kind: 'positions', positions, widths: widthArrays[0]!}, {withStates: true})],
            ['widths', 1, () => prepared.evaluate({kind: 'widths', widths: widthArrays[1]!}, {withStates: true})],
          ]
          for (const [input, which, evaluate] of evaluations) {
            const evaluation = await evaluate()
            totals.evaluations++
            solutions[which]!.forEach((solution, index) => {
              const out = evaluation.out.subarray(index * (breaks + 1), (index + 1) * (breaks + 1))
              const states = evaluation.states!.subarray(index * breaks * window, (index + 1) * breaks * window)
              const expected = [...expectedOut(solution.costs, solution.predecessors), ...expectedStates(solution.costs, window)]
              const actual = [...out, ...states]
              const mismatched = expected.filter((value, at) => actual[at] !== value).length
              totals.comparedValues += expected.length
              totals.mismatchedValues += mismatched
              const breaksDiffer = breaksOf(evaluation.out, index, breaks).join() !== solution.breaks.join()
              if (breaksDiffer) totals.mismatchedBreaks++
              if ((mismatched > 0 || breaksDiffer) && totals.failures.length < 5) totals.failures.push({input, width: widths[index]![which], paragraph: paragraphs[index], mismatched})
            })
          }
          prepared.destroy()
          totals.batches++
          totals.paragraphs += paragraphs.length
          paragraphs.forEach((paragraph, index) => {
            for (const which of [0, 1]) {
              const solution = solutions[which]![index]!
              if (hasTie(paragraph, widths[index]![which]!, window, solution.costs)) totals.paragraphsWithTies++
              if (solution.totalCost > infeasible) totals.paragraphsWithTotalsPast2To22++
            }
          })
        }
        results.push(totals)
        log(`check ${kernel}, W = ${window}, n = ${breaks}: ${totals.paragraphs} paragraphs, ${totals.comparedValues} values compared, ${totals.mismatchedValues} mismatched, ${totals.mismatchedBreaks} mismatched breaks, ${totals.paragraphsWithTies} with ties, ${totals.paragraphsWithTotalsPast2To22} past 2^22`)
        await post(false)
      }
    }
  }
}

try {
  if (config.mode === 'check') await runChecks()
  else await runMain()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
