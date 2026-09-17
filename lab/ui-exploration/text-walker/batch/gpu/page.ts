// The GPU measurement page for many paragraphs. run.ts serves it, opens it in headless Chrome, and writes what it posts to
// /result. The page generates the paragraphs with pretext and the fake canvas, as Bun does. Modes, from /config:
// - 'main': for each paragraph size, first compares this page's pretext line counts and cells with the files from
//   shaders.ts's expected command. Then for each count: pretext's layout() and writing the cells in this page, and for each
//   guard, the times of one evaluation. With the own-width shader: new cells with and without readback, with a timestamp
//   query, and only the upload. With the shared-width shader, where the cells stay on the GPU: a new width with and
//   without readback, and with a timestamp query. Consecutive evaluations alternate between the two widths of the
//   expected files, and every readback is compared with pretext's line counts at its width.
// - 'check': both shaders with both guards at many widths, compared with pretext's layout() in this page.
// - 'sweep': the own-width shader at other workgroup sizes, with the first guard.
import {layout} from '@chenglou/pretext'
import type {Guard} from '../../../codegen/wgsl.ts'
import {fakeTextWidth} from '../../fake-canvas.ts'
import {type BatchParagraph, type ParagraphSize, batchCapacities, lineHeight, timingParagraphs} from '../paragraphs.ts'
import {instanceCellCount, writeInstanceCells} from '../programs.ts'
import {createCellsHasher, createSharedWidthWriter, sharedWidthCellCount} from './cells.ts'
import {type Evaluation, createBatchRunner} from './host.ts'
import type {BatchShader, ExpectedMeta, ShaderPlan} from './shaders.ts'

export type PageConfig = {
  mode: 'main' | 'check' | 'sweep'
  sizes: ParagraphSize[]
  counts: number[]
  guards: Guard[]
  // Main and check use the first.
  workgroupSizes: number[]
  // Check mode: every width, the paragraphs for each paragraph at its own width and for the shared-width shader, and the
  // first paragraphs, which the own-width shader runs at every width.
  checkWidths: number[]
  checkCount: number
  checkGridCount: number
  // Goes into every shader's source, see host.ts. A salt that no earlier run used gives cold compile times.
  shaderSalt: number
  warmupMs: number
  sampleMs: number
  minimumSamples: number
  maximumSamples: number
  cpuWarmupMs: number
  cpuSampleMs: number
  cpuSamples: number
}

// pretext measures with OffscreenCanvas, and Chrome has one, so paragraphs.ts's installBatchCanvas would keep Chrome's.
// This page replaces it with the fake canvas before the first prepare call.
class FakeContext {
  font = ''
  measureText(text: string) {
    return {width: fakeTextWidth(text, this.font)}
  }
}
Reflect.set(globalThis, 'OffscreenCanvas', class {
  getContext() {
    return new FakeContext()
  }
})

const round = (value: number) => Math.round(value * 1000) / 1000
function summary(values: readonly (number | undefined)[]) {
  const sorted = values.filter(value => value !== undefined).sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  return {count: sorted.length, median: round(at(0.5)), p10: round(at(0.1)), p90: round(at(0.9)), min: round(sorted[0]!), max: round(sorted.at(-1)!)}
}
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[values.length >> 1]!
const usedHeapMegabytes = () => {
  const memory = (performance as unknown as {memory?: {usedJSHeapSize: number}}).memory
  return memory === undefined ? undefined : Math.round(memory.usedJSHeapSize / 1e6)
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

const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no WebGPU adapter')
const hasTimestamps = adapter.features.has('timestamp-query')
const device = await adapter.requestDevice({
  requiredFeatures: hasTimestamps ? ['timestamp-query'] : [],
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
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

async function compileRunner(size: ParagraphSize, plan: ShaderPlan, guard: Guard, workgroupSize: number, capacity: number) {
  const shader = await (await fetch(`/shader?size=${size}&plan=${plan}&guard=${guard}&workgroup=${workgroupSize}`)).json() as BatchShader
  const runner = await createBatchRunner(device, shader, capacity, config.shaderSalt)
  compileTimes.push({size, plan, guard, workgroupSize, shaderSalt: config.shaderSalt, statements: shader.statementCount, shaderBytes: shader.shaderBytes, compileMs: round(runner.compileMs)})
  log(`${size}, ${plan}, ${guard} guard, workgroup ${workgroupSize}: compiled ${shader.statementCount} statements in ${round(runner.compileMs)} ms`)
  return {shader, runner}
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

// µs per paragraph of a JavaScript loop over `count` paragraphs: cpuWarmupMs and at least 3 runs of warmup, then
// cpuSamples samples of whole runs, each at least cpuSampleMs, and their median, as cpu-time.ts does in Bun.
function timeCpu(run: () => void, count: number) {
  const warmUntil = performance.now() + config.cpuWarmupMs
  for (let runs = 0; runs < 3 || performance.now() < warmUntil; runs++) run()
  const samples: number[] = []
  for (let index = 0; index < config.cpuSamples; index++) {
    let runs = 0
    const started = performance.now()
    do {
      run()
      runs++
    } while (performance.now() - started < config.cpuSampleMs)
    samples.push((performance.now() - started) * 1000 / (runs * count))
  }
  return {microsecondsPerParagraph: round(median(samples)), samples: samples.map(round)}
}

type Timed = Evaluation & {cellsMs: number}
const summarizeRecords = (records: readonly Timed[]) => ({
  cellsMs: summary(records.map(record => record.cellsMs)),
  uploadMs: summary(records.map(record => record.uploadMs)),
  encodeAndSubmitMs: summary(records.map(record => record.encodeAndSubmitMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  totalMs: summary(records.map(record => record.totalMs)),
  totalWithCellsMs: summary(records.map(record => record.totalMs + record.cellsMs)),
  passMs: summary(records.map(record => record.passMs)),
})

function createChecker(expectedByWidth: ReadonlyMap<number, Int32Array>) {
  const totals = {readbacks: 0, lineCounts: 0, mismatches: 0}
  return {
    totals,
    check(lineCounts: Float32Array, count: number, width: number) {
      const expected = expectedByWidth.get(width)!
      totals.readbacks++
      totals.lineCounts += count
      for (let index = 0; index < count; index++) if (lineCounts[index] !== expected[index]) totals.mismatches++
    },
  }
}

// The paragraphs of one size, their cells for both shaders, and pretext's line counts in this page, compared with Bun's.
async function setUpSize(size: ParagraphSize, maxCount: number) {
  const expectedMeta = await (await fetch('/expected/expected.json')).json() as ExpectedMeta
  if (expectedMeta.maxCount < maxCount || !config.counts.every(count => expectedMeta.counts.includes(count))) throw new Error('the expected files were written for other counts')
  const capacity = batchCapacities[size]
  const prepareStarted = performance.now()
  const paragraphs: BatchParagraph[] = timingParagraphs(size, maxCount)
  const prepareMs = performance.now() - prepareStarted
  const heapAfterPrepareMegabytes = usedHeapMegabytes()
  const widths = expectedMeta.widths
  const bunCounts = new Int32Array(await (await fetch(`/expected/line-counts-${size}.i32`)).arrayBuffer())
  const expectedByWidth = new Map<number, Int32Array>()
  let pretextMismatches = 0
  widths.forEach((width, widthIndex) => {
    const counts = Int32Array.from(paragraphs, paragraph => layout(paragraph.prepared, width, lineHeight).lineCount)
    counts.forEach((lines, index) => {
      if (lines !== bunCounts[index * widths.length + widthIndex]) pretextMismatches++
    })
    expectedByWidth.set(width, counts)
  })
  const columns = instanceCellCount(capacity)
  const ownCells = new Float32Array(maxCount * columns)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(ownCells, index * columns, capacity, paragraph, widths[0]!))
  const hasher = createCellsHasher()
  const hashes: {count: number, page: number, bun: number | undefined}[] = []
  let hashed = 0
  for (const count of [...config.counts].sort((left, right) => left - right)) {
    hasher.add(ownCells.subarray(hashed * columns, count * columns))
    hashed = count
    hashes.push({count, page: hasher.value(), bun: expectedMeta.sizes[size]?.hashes[String(count)]})
  }
  const sharedColumns = sharedWidthCellCount(capacity)
  const sharedCells = new Float32Array(maxCount * sharedColumns)
  const writeShared = createSharedWidthWriter(capacity)
  paragraphs.forEach((paragraph, index) => writeShared(sharedCells, index * sharedColumns, paragraph))
  const setup = {
    size, maxCount, widths, prepareMs: round(prepareMs), heapAfterPrepareMegabytes, heapAfterCellsMegabytes: usedHeapMegabytes(),
    pretextMismatchesAgainstBun: pretextMismatches, cellHashesEqualBun: hashes.every(hash => hash.page === hash.bun), hashes,
    totalLines: widths.map(width => expectedByWidth.get(width)!.reduce((total, lines) => total + lines, 0)),
    megabytesPerParagraph: columns * 4 / 1e6,
  }
  log(`${size}: prepared ${maxCount} paragraphs in ${setup.prepareMs} ms, heap ${setup.heapAfterCellsMegabytes} MB, pretext mismatches against Bun ${pretextMismatches}, cell hashes equal Bun ${setup.cellHashesEqualBun}`)
  if (pretextMismatches > 0 || !setup.cellHashesEqualBun) throw new Error(`this page's paragraphs differ from Bun's: ${JSON.stringify(setup)}`)
  return {capacity, paragraphs, expectedByWidth, columns, ownCells, sharedColumns, sharedCells, setup}
}

async function runMain() {
  const workgroupSize = config.workgroupSizes[0]!
  for (const size of config.sizes) {
    const maxCount = Math.max(...config.counts)
    const {capacity, paragraphs, expectedByWidth, columns, ownCells, sharedCells, setup} = await setUpSize(size, maxCount)
    const [width, otherWidth] = setup.widths as [number, number]
    const cpu = config.counts.map(count => {
      const counts = new Int32Array(count)
      const pretext = timeCpu(() => {
        for (let index = 0; index < count; index++) counts[index] = layout(paragraphs[index]!.prepared, width, lineHeight).lineCount
      }, count)
      const expected = expectedByWidth.get(width)!
      const pretextMismatches = counts.filter((lines, index) => lines !== expected[index]).length
      const writeCells = timeCpu(() => {
        for (let index = 0; index < count; index++) writeInstanceCells(ownCells, index * columns, capacity, paragraphs[index]!, width)
      }, count)
      log(`${size}, ${count} paragraphs in this page: pretext ${pretext.microsecondsPerParagraph} µs per paragraph, writing the cells ${writeCells.microsecondsPerParagraph} µs`)
      return {count, pretext, pretextMismatches, writeCells}
    })
    results.push({kind: 'setup', ...setup, cpu})
    await post(false)
    for (const guard of config.guards) {
      for (const plan of ['own-width', 'shared-width'] as const) {
        const {shader, runner} = await compileRunner(size, plan, guard, workgroupSize, maxCount)
        const checker = createChecker(expectedByWidth)
        let sharedUploadMs: number | undefined
        if (plan === 'shared-width') sharedUploadMs = round((await runner.evaluate({count: maxCount, cells: sharedCells, readback: false, timestamps: false, compute: false})).totalMs)
        for (const count of config.counts) {
          let flip = 0
          const nextWidth = () => flip++ % 2 === 0 ? width : otherWidth
          const evaluateOnce = async ({readback, timestamps, compute = true}: {readback: boolean, timestamps: boolean, compute?: boolean}): Promise<Timed> => {
            const chosen = nextWidth()
            if (plan === 'own-width') {
              const cellsStarted = performance.now()
              for (let index = 0; index < count; index++) writeInstanceCells(ownCells, index * columns, capacity, paragraphs[index]!, chosen)
              const cellsMs = performance.now() - cellsStarted
              const evaluation = await runner.evaluate({count, cells: ownCells, readback, timestamps, compute})
              if (readback) checker.check(runner.lineCounts, count, chosen)
              return {...evaluation, cellsMs}
            }
            const evaluation = await runner.evaluate({count, width: chosen, readback, timestamps, compute})
            if (readback) checker.check(runner.lineCounts, count, chosen)
            return {...evaluation, cellsMs: 0}
          }
          const firstStarted = performance.now()
          await evaluateOnce({readback: true, timestamps: false})
          const firstEvaluationMs = round(performance.now() - firstStarted)
          const readback = await sample(() => evaluateOnce({readback: true, timestamps: false}))
          const noReadback = await sample(() => evaluateOnce({readback: false, timestamps: false}))
          const passTimestamps = hasTimestamps ? await sample(() => evaluateOnce({readback: true, timestamps: true})) : []
          const uploadOnly = plan === 'own-width' ? await sample(() => evaluateOnce({readback: false, timestamps: false, compute: false})) : []
          const result = {
            kind: 'gpu', size, plan, guard, workgroupSize, count, statements: shader.statementCount,
            megabytesUploaded: plan === 'own-width' ? round(count * columns * 4 / 1e6) : 4e-6, sharedUploadMs, firstEvaluationMs,
            readback: summarizeRecords(readback), noReadback: summarizeRecords(noReadback), passTimestamps: summarizeRecords(passTimestamps), uploadOnly: summarizeRecords(uploadOnly),
            checks: {...checker.totals},
          }
          results.push(result)
          log(`${size}, ${plan}, ${guard} guard, ${count} paragraphs: with readback ${result.readback.totalWithCellsMs?.median} ms (cells ${result.readback.cellsMs?.median}, GPU ${result.readback.totalMs?.median}), without readback ${result.noReadback.totalWithCellsMs?.median} ms, pass ${result.passTimestamps.passMs?.median} ms, checks ${JSON.stringify(checker.totals)}`)
          await post(false)
        }
        runner.destroy()
      }
    }
  }
}

async function runSweep() {
  const guard = config.guards[0]!
  for (const size of config.sizes) {
    const maxCount = Math.max(...config.counts)
    const {capacity, paragraphs, expectedByWidth, columns, ownCells, setup} = await setUpSize(size, maxCount)
    const [width, otherWidth] = setup.widths as [number, number]
    for (const workgroupSize of config.workgroupSizes) {
      const {runner} = await compileRunner(size, 'own-width', guard, workgroupSize, maxCount)
      const checker = createChecker(expectedByWidth)
      for (const count of config.counts) {
        let flip = 0
        const evaluateOnce = async (timestamps: boolean): Promise<Timed> => {
          const chosen = flip++ % 2 === 0 ? width : otherWidth
          const cellsStarted = performance.now()
          for (let index = 0; index < count; index++) writeInstanceCells(ownCells, index * columns, capacity, paragraphs[index]!, chosen)
          const cellsMs = performance.now() - cellsStarted
          const evaluation = await runner.evaluate({count, cells: ownCells, readback: true, timestamps})
          checker.check(runner.lineCounts, count, chosen)
          return {...evaluation, cellsMs}
        }
        const readback = await sample(() => evaluateOnce(false))
        const passTimestamps = hasTimestamps ? await sample(() => evaluateOnce(true)) : []
        const result = {kind: 'sweep', size, plan: 'own-width', guard, workgroupSize, count, readback: summarizeRecords(readback), passTimestamps: summarizeRecords(passTimestamps), checks: {...checker.totals}}
        results.push(result)
        log(`sweep ${size}, workgroup ${workgroupSize}, ${count} paragraphs: GPU ${result.readback.totalMs?.median} ms, pass ${result.passTimestamps.passMs?.median} ms, checks ${JSON.stringify(checker.totals)}`)
        await post(false)
      }
      runner.destroy()
    }
  }
}

async function runChecks() {
  const workgroupSize = config.workgroupSizes[0]!
  const widths = config.checkWidths
  for (const size of config.sizes) {
    const capacity = batchCapacities[size]
    const count = config.checkCount
    const paragraphs = timingParagraphs(size, count)
    const expectedStarted = performance.now()
    // expected[paragraph × widths + width]: pretext's line count in this page.
    const expected = new Uint8Array(count * widths.length)
    paragraphs.forEach((paragraph, index) => {
      widths.forEach((width, widthIndex) => {
        expected[index * widths.length + widthIndex] = layout(paragraph.prepared, width, lineHeight).lineCount
      })
    })
    log(`check ${size}: pretext's line counts of ${count} paragraphs at ${widths.length} widths in ${round(performance.now() - expectedStarted)} ms`)
    const columns = instanceCellCount(capacity)
    const chunk = Math.min(65_536, count)
    for (const guard of config.guards) {
      const totals = {
        size, guard, workgroupSize, paragraphs: count, widths: widths.length,
        ownWidthEachParagraph: {instances: 0, mismatches: 0},
        ownWidthEveryWidth: {instances: 0, mismatches: 0},
        sharedWidthEveryWidth: {instances: 0, mismatches: 0},
        failures: [] as {kind: string, paragraph: number, width: number, gpu: number, expected: number}[],
      }
      const own = (await compileRunner(size, 'own-width', guard, workgroupSize, chunk)).runner
      const cells = new Float32Array(chunk * columns)
      // Runs the own-width shader over (paragraph, width index) pairs in chunks, and compares with pretext.
      const runPairs = async (kind: 'ownWidthEachParagraph' | 'ownWidthEveryWidth', pairs: number, pairAt: (pair: number) => [number, number]) => {
        for (let first = 0; first < pairs; first += chunk) {
          const inChunk = Math.min(chunk, pairs - first)
          for (let offset = 0; offset < inChunk; offset++) {
            const [paragraph, widthIndex] = pairAt(first + offset)
            writeInstanceCells(cells, offset * columns, capacity, paragraphs[paragraph]!, widths[widthIndex]!)
          }
          await own.evaluate({count: inChunk, cells, readback: true, timestamps: false})
          for (let offset = 0; offset < inChunk; offset++) {
            const [paragraph, widthIndex] = pairAt(first + offset)
            const wanted = expected[paragraph * widths.length + widthIndex]!
            totals[kind].instances++
            if (own.lineCounts[offset] !== wanted) {
              totals[kind].mismatches++
              if (totals.failures.length < 20) totals.failures.push({kind, paragraph, width: widths[widthIndex]!, gpu: own.lineCounts[offset]!, expected: wanted})
            }
          }
        }
      }
      await runPairs('ownWidthEachParagraph', count, pair => [pair, pair % widths.length])
      await runPairs('ownWidthEveryWidth', config.checkGridCount * widths.length, pair => [Math.floor(pair / widths.length), pair % widths.length])
      own.destroy()
      const shared = (await compileRunner(size, 'shared-width', guard, workgroupSize, count)).runner
      const sharedColumns = sharedWidthCellCount(capacity)
      const sharedCells = new Float32Array(count * sharedColumns)
      const writeShared = createSharedWidthWriter(capacity)
      paragraphs.forEach((paragraph, index) => writeShared(sharedCells, index * sharedColumns, paragraph))
      await shared.evaluate({count, cells: sharedCells, readback: false, timestamps: false, compute: false})
      for (let widthIndex = 0; widthIndex < widths.length; widthIndex++) {
        await shared.evaluate({count, width: widths[widthIndex]!, readback: true, timestamps: false})
        for (let paragraph = 0; paragraph < count; paragraph++) {
          const wanted = expected[paragraph * widths.length + widthIndex]!
          totals.sharedWidthEveryWidth.instances++
          if (shared.lineCounts[paragraph] !== wanted) {
            totals.sharedWidthEveryWidth.mismatches++
            if (totals.failures.length < 20) totals.failures.push({kind: 'sharedWidthEveryWidth', paragraph, width: widths[widthIndex]!, gpu: shared.lineCounts[paragraph]!, expected: wanted})
          }
        }
      }
      shared.destroy()
      results.push({kind: 'check', ...totals})
      log(`check ${size}, ${guard} guard: ${JSON.stringify({each: totals.ownWidthEachParagraph, every: totals.ownWidthEveryWidth, shared: totals.sharedWidthEveryWidth})}`)
      await post(false)
    }
  }
}

try {
  if (config.mode === 'check') await runChecks()
  else if (config.mode === 'sweep') await runSweep()
  else await runMain()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
