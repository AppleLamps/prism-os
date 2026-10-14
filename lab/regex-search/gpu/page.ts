// The GPU measurement page. run.ts serves it, opens it in headless Chrome, and writes what it posts to /result. Modes,
// from /config:
// - 'sweep': every kernel choice at each S and text length, to pick one kernel per S.
// - 'main': for each S and text length, per-evaluation times with and without readback, the compute pass from timestamp
//   queries, only the upload, one pass per level, leaf writing in JavaScript, and denseReach in this page. The same with
//   the leaves gathered on the GPU from the class of every code point, see kernels.ts. Every readback is compared bit for
//   bit with the files that cpu-time.ts writes.
// - 'frames': at one text length, when results arrive relative to requestAnimationFrame, with both inputs.
// - 'check': many patterns and texts at each S and text length, with both inputs, compared with productTreeInputs run in
//   this page. The other modes check one pattern and one text per size.
import {codePointsOf} from '../../../src/json-search/regex/host.ts'
import {compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {productTreeInputs} from '../tree-inputs.ts'
import {classInputs, createLeafWriter, denseReach, gpuPlan, packReach, textOf} from './automaton-inputs.ts'
import {type Evaluation, type TimestampMode, createGpuTree, kernelChoices} from './kernels.ts'

export type PageConfig = {
  mode: 'sweep' | 'main' | 'frames' | 'check'
  patterns: Record<string, string>
  states: number[]
  textLengths: number[]
  // The kernel choice per S, e.g. {"32": "row-16x16"}. Sweep mode tries every choice.
  kernels: Record<string, string>
  // Goes into every shader's source, see kernels.ts. A salt that no earlier run used gives cold compile times.
  shaderSalt: number
  warmupMs: number
  sampleMs: number
  minimumSamples: number
  maximumSamples: number
  frames: number
  // The files under /expected/, e.g. reach-reference-32-1024.bin.
  expectedFiles: string[]
}

type Input = 'leaves' | 'classes'

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

async function loadReferences(states: number, textLength: number) {
  const references: {name: string, words: Uint32Array}[] = []
  for (const name of ['reference', 'data-reverse', 'tree-ends', 'js-dense']) {
    const file = `reach-${name}-${states}-${textLength}.bin`
    if (!config.expectedFiles.includes(file)) continue
    references.push({name, words: new Uint32Array(await (await fetch(`/expected/${file}`)).arrayBuffer())})
  }
  if (!references.some(reference => reference.name === 'reference')) throw new Error(`no reference bits for S = ${states}, N = ${textLength}`)
  return references
}

function mismatchedPositions(words: Uint32Array, expected: Uint32Array) {
  let mismatched = Math.abs(words.length - expected.length)
  for (let position = 0; position < Math.min(words.length, expected.length); position++) if (words[position] !== expected[position]) mismatched++
  return mismatched
}

function createChecker(references: {name: string, words: Uint32Array}[]) {
  const counts: Record<string, {readbacks: number, mismatchedPositions: number}> = Object.fromEntries(references.map(({name}) => [name, {readbacks: 0, mismatchedPositions: 0}]))
  return {
    counts,
    check(words: Uint32Array | undefined) {
      if (words === undefined) return
      for (const {name, words: expected} of references) {
        counts[name]!.readbacks++
        counts[name]!.mismatchedPositions += mismatchedPositions(words, expected)
      }
    },
  }
}

// Evaluates until at least warmupMs and 3 evaluations have passed, then samples until sampleMs and minimumSamples have
// passed, or maximumSamples.
async function sample<Record>(evaluateOnce: () => Promise<Record>) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 || performance.now() - warmStarted < config.warmupMs; warm++) await evaluateOnce()
  const records: Record[] = []
  const started = performance.now()
  while (records.length < config.maximumSamples && (records.length < config.minimumSamples || performance.now() - started < config.sampleMs)) records.push(await evaluateOnce())
  return records
}

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
  limits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup},
}

const compileTimes: unknown[] = []
const results: unknown[] = []
report['compileTimes'] = compileTimes
report['results'] = results
async function compileTree(states: number, kernel: string) {
  const tree = await createGpuTree(device, states, kernelChoices[kernel]!, config.shaderSalt)
  compileTimes.push({states, kernel, shaderSalt: config.shaderSalt, ...tree.compileTimes})
  log(`S = ${states}: compiled ${kernel} in ${JSON.stringify(tree.compileTimes)}`)
  return tree
}

// Everything one text length needs: the inputs, the leaves, the plan and its buffers on the GPU, and the references.
async function setUp(tree: Awaited<ReturnType<typeof createGpuTree>>, states: number, textLength: number) {
  const compiled = compilePattern(config.patterns[String(states)]!)
  const inputs = classInputs(compiled, textOf(textLength), states)
  const writer = createLeafWriter(inputs)
  const leaves = new Float32Array(textLength * writer.size * writer.size)
  const lastColumn = new Float32Array(writer.size)
  const classWords = new Uint32Array(textLength)
  const planStarted = performance.now()
  const plan = gpuPlan(textLength)
  const planMs = performance.now() - planStarted
  const prepareStarted = performance.now()
  const prepared = await tree.prepare(plan, writer.perClass)
  const prepareMs = performance.now() - prepareStarted
  const checker = createChecker(await loadReferences(states, textLength))
  // leafMs is the JavaScript work before the upload: writing the leaves, or copying the classes into 32-bit words.
  const evaluateOnce = async ({input, ...options}: {input: Input, readback: boolean, timestamps: TimestampMode, compute?: boolean}) => {
    const leafStarted = performance.now()
    if (input === 'leaves') writer.write(leaves, lastColumn)
    else classWords.set(inputs.classOf)
    const leafMs = performance.now() - leafStarted
    const evaluation: Evaluation = await prepared.evaluate(input === 'leaves' ? {kind: 'leaves', leaves, lastColumn} : {kind: 'classes', classes: classWords}, options)
    checker.check(evaluation.words)
    return {...evaluation, leafMs}
  }
  const shape = {
    levels: plan.levels.length,
    matrixCombines: plan.matrixTriples.length / 3,
    vectorCombines: plan.vectorTriples.length / 3,
    leafMegabytes: leaves.byteLength / 1e6,
    matrixBufferMegabytes: plan.matrixSlots * writer.size * writer.size * 4 / 1e6,
  }
  return {inputs, plan, prepared, checker, evaluateOnce, planMs, prepareMs, shape, pattern: compiled.pattern}
}

const summarizeRecords = (records: (Evaluation & {leafMs: number})[]) => ({
  leafMs: summary(records.map(record => record.leafMs)),
  uploadMs: summary(records.map(record => record.uploadMs)),
  encodeAndSubmitMs: summary(records.map(record => record.encodeAndSubmitMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  totalMs: summary(records.map(record => record.totalMs)),
  totalWithLeavesMs: summary(records.map(record => record.totalMs + record.leafMs)),
  passMs: summary(records.map(record => record.passMs)),
})

async function measureSize(tree: Awaited<ReturnType<typeof createGpuTree>>, kernel: string, states: number, textLength: number) {
  const setup = await setUp(tree, states, textLength)
  const {plan, prepared, checker, evaluateOnce} = setup
  const firstStarted = performance.now()
  await evaluateOnce({input: 'leaves', readback: true, timestamps: 'none'})
  const firstEvaluationMs = performance.now() - firstStarted
  const readback = await sample(() => evaluateOnce({input: 'leaves', readback: true, timestamps: 'none'}))
  const noReadback = await sample(() => evaluateOnce({input: 'leaves', readback: false, timestamps: 'none'}))
  const passTimestamps = hasTimestamps ? await sample(() => evaluateOnce({input: 'leaves', readback: true, timestamps: 'pass'})) : []
  // Only the upload: writeBuffer and an empty command buffer, until onSubmittedWorkDone resolves.
  const uploadOnly = await sample(() => evaluateOnce({input: 'leaves', readback: false, timestamps: 'none', compute: false}))
  const gatherReadback = await sample(() => evaluateOnce({input: 'classes', readback: true, timestamps: 'none'}))
  const gatherPassTimestamps = hasTimestamps ? await sample(() => evaluateOnce({input: 'classes', readback: true, timestamps: 'pass'})) : []
  const gatherUploadOnly = await sample(() => evaluateOnce({input: 'classes', readback: false, timestamps: 'none', compute: false}))
  // One compute pass per level: 1 warm evaluation and 5 samples, and each level's median.
  let levelBreakdown: unknown
  if (hasTimestamps) {
    await evaluateOnce({input: 'leaves', readback: true, timestamps: 'levels'})
    const levelRecords: number[][] = []
    for (let index = 0; index < 5; index++) levelRecords.push((await evaluateOnce({input: 'leaves', readback: true, timestamps: 'levels'})).levelMs!)
    levelBreakdown = {
      levels: plan.levels.map(({matrixCount, vectorCount}, index) => ({matrixCount, vectorCount, medianMs: summary(levelRecords.map(record => record[index]))!.median})),
      packMs: summary(levelRecords.map(record => record[plan.levels.length])),
      passSumMs: summary(levelRecords.map(record => record.reduce((total, value) => total + value, 0))),
    }
  }
  // denseReach in this page: 7 samples of at least 100 ms each, after 300 ms of warmup, in µs per evaluation.
  const reach = new Uint8Array(textLength * states)
  denseReach(setup.inputs, reach)
  const denseChecker = createChecker(await loadReferences(states, textLength))
  denseChecker.check(packReach(reach, states, textLength))
  const warmUntil = performance.now() + 300
  while (performance.now() < warmUntil) denseReach(setup.inputs, reach)
  const denseSamples: number[] = []
  for (let index = 0; index < 7; index++) {
    let iterations = 0
    const started = performance.now()
    do {
      denseReach(setup.inputs, reach)
      iterations++
    } while (performance.now() - started < 100)
    denseSamples.push((performance.now() - started) * 1000 / iterations)
  }
  prepared.destroy()
  return {
    states, textLength, kernel, pattern: setup.pattern, ...setup.shape, planMs: round(setup.planMs), prepareMs: round(setup.prepareMs), firstEvaluationMs: round(firstEvaluationMs),
    readback: summarizeRecords(readback), noReadback: summarizeRecords(noReadback), passTimestamps: summarizeRecords(passTimestamps), uploadOnly: summarizeRecords(uploadOnly), levelBreakdown,
    gather: {readback: summarizeRecords(gatherReadback), passTimestamps: summarizeRecords(gatherPassTimestamps), uploadOnly: summarizeRecords(gatherUploadOnly)},
    denseReachInPageMicroseconds: {median: round(summary(denseSamples)!.median), samples: denseSamples.map(round)},
    checks: checker.counts, denseReachInPageChecks: denseChecker.counts,
  }
}

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}
const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!

// A random pattern over a few atoms, e.g. `((a)(b)|[^a])*`, including empty groups, empty alternatives and nullable
// patterns.
function randomPattern(random: () => number, depth: number): string {
  const roll = random()
  if (depth <= 0 || roll < 0.35) return pick(random, ['a', 'b', 'x', '.', '[^]', '[ab]', '[^a]', '()', '[]', '[^b]', '\\d'])
  if (roll < 0.6) return `(${randomPattern(random, depth - 1)})(${randomPattern(random, depth - 1)})`
  if (roll < 0.8) return `(${randomPattern(random, depth - 1)}|${random() < 0.15 ? '' : randomPattern(random, depth - 1)})`
  return `(${randomPattern(random, depth - 1)})${pick(random, ['?', '*', '+'])}`
}

// For one S and text length: the measured pattern, hand-written patterns, e.g. 32 states that all reach an accepting
// state, so the words' bit 31 is 1, and 10 random patterns. Each over 6 texts, 2 of them shorter than the text length,
// where the positions past the end of the text read no step, like form (a)'s -1 cells.
function checkCases(states: number, textLength: number) {
  const random = createRandom(states * 100_003 + textLength)
  const repeated = (unit: string, length: number) => codePointsOf(unit.repeat(length)).slice(0, length)
  const randomText = (length: number) => Array.from({length}, () => pick(random, codePointsOf('abcx9\n😀 ')))
  const handWritten: Record<number, string[]> = {
    8: ['a*', '[^]*', '(x|y)?z*', '[^a]+', '[^a-z]x|\\d+', 'a|ab', 'a+b|a'],
    16: ['(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o)+', '(ab|a)(bc|c)*x?'],
    32: ['[ab]*'.repeat(31), `(${Array.from({length: 31}, () => '[ab]').join('|')})+`, '[ab]'.repeat(31)],
  }
  const patterns = [config.patterns[String(states)]!, ...handWritten[states] ?? []]
  for (let attempt = 0; attempt < 1000 && patterns.length < (handWritten[states]?.length ?? 0) + 11; attempt++) {
    const pattern = randomPattern(random, states <= 8 ? 3 : states <= 16 ? 4 : 5)
    if (compilePattern(pattern).automaton.stateCount <= states) patterns.push(pattern)
  }
  return patterns.flatMap(pattern => [
    textOf(textLength),
    textOf(Math.ceil(textLength / 2)),
    repeated('ab', textLength),
    repeated('abx', textLength),
    randomText(textLength),
    randomText(Math.floor(textLength / 3)),
  ].map(codePoints => ({pattern, codePoints})))
}

async function runChecks() {
  for (const states of config.states) {
    const tree = await compileTree(states, config.kernels[String(states)] ?? 'row-16x16')
    for (const textLength of config.textLengths) {
      const totals = {states, textLength, cases: 0, positions: 0, positionsPastTheText: 0, positionsWithHighestStateBit: 0, mismatchedWithLeaves: 0, mismatchedWithClasses: 0, failures: [] as {pattern: string, codePoints: number[]}[]}
      for (const {pattern, codePoints} of checkCases(states, textLength)) {
        const compiled = compilePattern(pattern)
        const expected = packReach(productTreeInputs(compiled, codePoints, {states, textLength}).reach, states, textLength)
        const inputs = classInputs(compiled, codePoints, states, textLength)
        const writer = createLeafWriter(inputs)
        const leaves = new Float32Array(textLength * writer.size * writer.size)
        const lastColumn = new Float32Array(writer.size)
        writer.write(leaves, lastColumn)
        const prepared = await tree.prepare(gpuPlan(textLength), writer.perClass)
        const fromLeaves = await prepared.evaluate({kind: 'leaves', leaves, lastColumn}, {readback: true, timestamps: 'none'})
        const fromClasses = await prepared.evaluate({kind: 'classes', classes: Uint32Array.from(inputs.classOf)}, {readback: true, timestamps: 'none'})
        prepared.destroy()
        const withLeaves = mismatchedPositions(fromLeaves.words!, expected)
        const withClasses = mismatchedPositions(fromClasses.words!, expected)
        totals.cases++
        totals.positions += textLength
        totals.positionsPastTheText += textLength - codePoints.length
        totals.positionsWithHighestStateBit += expected.filter(word => ((word >>> (states - 1)) & 1) === 1).length
        totals.mismatchedWithLeaves += withLeaves
        totals.mismatchedWithClasses += withClasses
        if (withLeaves + withClasses > 0 && totals.failures.length < 20) totals.failures.push({pattern, codePoints})
      }
      results.push(totals)
      log(`check S = ${states}, N = ${textLength}: ${totals.cases} cases, mismatched positions ${totals.mismatchedWithLeaves} with uploaded leaves and ${totals.mismatchedWithClasses} with gathered leaves`)
      await post(false)
    }
  }
}

async function main() {
  if (config.mode === 'check') {
    await runChecks()
  } else if (config.mode === 'sweep') {
    for (const states of config.states) {
      for (const kernel of Object.keys(kernelChoices)) {
        const tree = await compileTree(states, kernel)
        for (const textLength of config.textLengths) {
          const setup = await setUp(tree, states, textLength)
          const records = await sample(() => setup.evaluateOnce({input: 'leaves', readback: true, timestamps: hasTimestamps ? 'pass' : 'none'}))
          setup.prepared.destroy()
          const summarized = summarizeRecords(records)
          results.push({states, textLength, kernel, ...setup.shape, ...summarized, checks: setup.checker.counts})
          log(`sweep S = ${states}, N = ${textLength}, ${kernel}: pass ${summarized.passMs?.median} ms, total ${summarized.totalMs?.median} ms, checks ${JSON.stringify(setup.checker.counts)}`)
          await post(false)
        }
      }
    }
  } else if (config.mode === 'main') {
    for (const states of config.states) {
      const kernel = config.kernels[String(states)] ?? 'row-16x16'
      const tree = await compileTree(states, kernel)
      for (const textLength of config.textLengths) {
        const result = await measureSize(tree, kernel, states, textLength)
        results.push(result)
        log(`S = ${states}, N = ${textLength}: with readback ${result.readback.totalMs?.median} ms, without ${result.noReadback.totalMs?.median} ms, pass ${result.passTimestamps.passMs?.median} ms, leaves ${result.readback.leafMs?.median} ms, gathered ${result.gather.readback.totalMs?.median} ms, checks ${JSON.stringify(result.checks)}`)
        await post(false)
      }
    }
  } else {
    // requestAnimationFrame: in one callback, write the leaves or the classes and submit. The result arrives when mapAsync
    // resolves, and the first callback after that is the first frame that can draw it. The next evaluation starts in that
    // callback.
    for (const states of config.states) {
      const kernel = config.kernels[String(states)] ?? 'row-16x16'
      const tree = await compileTree(states, kernel)
      for (const textLength of config.textLengths) {
        for (const input of ['leaves', 'classes'] as const) {
          const setup = await setUp(tree, states, textLength)
          for (let warm = 0; warm < 10; warm++) await setup.evaluateOnce({input, readback: true, timestamps: 'none'})
          type Arrived = {submitFrame: number, submitCallbackStart: number, leafMs: number, arrivalMs: number, totalMs: number}
          type Drawn = Arrived & {framesUntilDrawn: number, submitToDrawCallbackMs: number}
          const frames: Drawn[] = []
          const callbackTimes: number[] = []
          await new Promise<void>(resolve => {
            let frameIndex = 0
            let inFlight = false
            let arrived: Arrived | undefined
            const onFrame = () => {
              frameIndex++
              const callbackStart = performance.now()
              callbackTimes.push(callbackStart)
              if (arrived !== undefined) {
                frames.push({...arrived, framesUntilDrawn: frameIndex - arrived.submitFrame, submitToDrawCallbackMs: round(callbackStart - arrived.submitCallbackStart)})
                arrived = undefined
              }
              if (frames.length >= config.frames) {
                resolve()
                return
              }
              if (!inFlight) {
                inFlight = true
                const submitFrame = frameIndex
                void setup.evaluateOnce({input, readback: true, timestamps: 'none'}).then(evaluation => {
                  arrived = {submitFrame, submitCallbackStart: callbackStart, leafMs: round(evaluation.leafMs), arrivalMs: round(performance.now() - callbackStart), totalMs: round(evaluation.totalMs)}
                  inFlight = false
                })
              }
              requestAnimationFrame(onFrame)
            }
            requestAnimationFrame(onFrame)
          })
          setup.prepared.destroy()
          const intervals = callbackTimes.slice(1).map((time, index) => time - callbackTimes[index]!)
          const arrival = summary(frames.map(frame => frame.arrivalMs))
          results.push({
            states, textLength, kernel, input, frameCount: frames.length, callbackIntervalMs: summary(intervals), arrivalMs: arrival,
            framesUntilDrawn: Object.entries(Object.groupBy(frames, frame => String(frame.framesUntilDrawn))).map(([count, list]) => ({framesUntilDrawn: Number(count), evaluations: list?.length ?? 0})),
            submitToDrawCallbackMs: summary(frames.map(frame => frame.submitToDrawCallbackMs)),
            frames, checks: setup.checker.counts,
          })
          log(`frames S = ${states}, N = ${textLength}, ${input}: arrival ${arrival?.median} ms after the submitting callback, checks ${JSON.stringify(setup.checker.counts)}`)
          await post(false)
        }
      }
    }
  }
}

try {
  await main()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
