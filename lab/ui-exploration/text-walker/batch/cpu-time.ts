// CPU timings of the batch line breaking programs, each variant in its own process. Every variant computes the line
// count of `count` paragraphs of one size at one width:
//   pretext                   pretext's layout() on each prepared paragraph, the bar to beat
//   write-cells               writeInstanceCells for every paragraph into one Float32Array, the host's work before any evaluation
//   executor-<formulation>    the program through createTensorEvaluator once per paragraph, with every paragraph's source
//                             table written before timing. Each call also checks the table against the cells' declared ranges.
//   generated-<formulation>   codegen's generated JavaScript over all paragraphs in blocks (one-hot and segment-walker only)
//   batched-<formulation>     codegen's batched executor over all paragraphs in blocks (one-hot and segment-walker only)
// One variant in this process, which prints one JSON line:
//   bun lab/ui-exploration/text-walker/batch/cpu-time.ts one executor-index-read long 1024 [--width 320] [--warmup-seconds 1]
// Every listed variant and size, each in its own process with a memory limit and a time limit, appending one JSON line
// per process to a file:
//   bun lab/ui-exploration/text-walker/batch/cpu-time.ts all --out <file.jsonl> [--variants pretext,executor-index-read]
//     [--sizes short,long] [--count 1024] [--width 320] [--warmup-seconds 1] [--processes 3] [--memory-limit-mb 16000]
//     [--time-limit-seconds 600]
import {appendFileSync} from 'node:fs'
import {layout} from '@chenglou/pretext'
import {type InstanceBackend, createBatchInstanceRunner} from './instances.ts'
import {type BatchParagraph, type ParagraphSize, assertFits, batchCapacities, batchParagraphs, expectedLineCount, lineHeight} from './paragraphs.ts'
import {type BatchProgram, type Formulation, allFormulations, buildBatchProgram, instanceCellCount, paragraphSourceTable, writeInstanceCells} from './programs.ts'

export const allVariants = [
  'pretext',
  'write-cells',
  ...allFormulations.map(formulation => `executor-${formulation}`),
  'generated-one-hot',
  'generated-segment-walker',
  'batched-one-hot',
  'batched-segment-walker',
]

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()

type Prepared = {
  run: () => void
  // The line counts of the last run, or null for write-cells.
  lineCounts: () => ArrayLike<number> | null
  details: object
}

function programDetails(program: BatchProgram) {
  return {
    capacity: program.capacity,
    sizes: program.compiled.size,
    indexReads: program.indexReads,
    buildMilliseconds: program.buildMilliseconds,
    compileMilliseconds: program.compileMilliseconds,
  }
}

// The line counts in `outputs`, after checking that every overflow output is 0.
function lineCountsOf(program: BatchProgram, outputs: Float32Array, count: number) {
  const outputCount = program.outputNames.length
  const counts = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    counts[index] = outputs[index * outputCount]!
    for (let output = 1; output < outputCount; output++) {
      if (outputs[index * outputCount + output] !== 0) throw new Error(`paragraph ${index} has ${program.outputNames[output]} = ${outputs[index * outputCount + output]}`)
    }
  }
  return counts
}

function prepareVariant(variant: string, paragraphs: readonly BatchParagraph[], size: ParagraphSize, width: number): Prepared {
  const capacity = batchCapacities[size]
  const count = paragraphs.length
  if (variant === 'pretext') {
    const counts = new Int32Array(count)
    return {
      run: () => {
        for (let index = 0; index < count; index++) counts[index] = layout(paragraphs[index]!.prepared, width, lineHeight).lineCount
      },
      lineCounts: () => counts,
      details: {},
    }
  }
  const columns = instanceCellCount(capacity)
  if (variant === 'write-cells') {
    const cells = new Float32Array(count * columns)
    return {
      run: () => {
        for (let index = 0; index < count; index++) writeInstanceCells(cells, index * columns, capacity, paragraphs[index]!, width)
      },
      lineCounts: () => null,
      details: {capacity, cellsPerParagraph: columns},
    }
  }
  const separator = variant.indexOf('-')
  const backend = variant.slice(0, separator)
  const formulation = variant.slice(separator + 1) as Formulation
  if (!allFormulations.includes(formulation)) throw new Error(`unknown variant ${variant}`)
  const program = buildBatchProgram(formulation, capacity)
  const outputs = new Float32Array(count * program.outputNames.length)
  if (backend === 'executor') {
    const tables = paragraphs.map(paragraph => paragraphSourceTable(program, paragraph, width))
    const outputCount = program.outputNames.length
    return {
      run: () => {
        for (let index = 0; index < count; index++) outputs.set(program.compiled.evaluate(tables[index]!).subarray(0, outputCount), index * outputCount)
      },
      lineCounts: () => lineCountsOf(program, outputs, count),
      details: programDetails(program),
    }
  }
  if (backend !== 'generated' && backend !== 'batched') throw new Error(`unknown variant ${variant}`)
  const runner = createBatchInstanceRunner(program, backend as InstanceBackend)
  const cells = new Float32Array(count * columns)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(cells, index * columns, capacity, paragraph, width))
  return {
    run: () => runner.run(cells, count, outputs),
    lineCounts: () => lineCountsOf(program, outputs, count),
    details: {
      ...programDetails(program),
      instancePlan: runner.plan.counts,
      instanceWidth: runner.plan.instanceWidth,
      blockSize: runner.blockSize,
      setupMilliseconds: runner.setupMilliseconds,
      generatedSourceBytes: runner.runner.sourceBytes,
    },
  }
}

function verify(variant: string, prepared: Prepared, expected: Int32Array) {
  const counts = prepared.lineCounts()
  if (counts === null) return
  for (let index = 0; index < expected.length; index++) {
    if (counts[index] !== expected[index]) throw new Error(`${variant}: paragraph ${index} has ${counts[index]} lines, pretext has ${expected[index]}`)
  }
}

function timeOne(variant: string, size: ParagraphSize, count: number, width: number, warmupSeconds: number) {
  const loadBefore = loadAverage()
  const prepareStarted = performance.now()
  const paragraphs = batchParagraphs(size, count)
  const prepareMilliseconds = performance.now() - prepareStarted
  for (const paragraph of paragraphs) assertFits(batchCapacities[size], paragraph)
  const expected = Int32Array.from(paragraphs, paragraph => expectedLineCount(paragraph, width))
  const prepared = prepareVariant(variant, paragraphs, size, width)
  prepared.run()
  verify(variant, prepared, expected)
  // --warmup-seconds of warmup, 1 by default, and at least 3 runs, then 7 samples of at least 300 ms each, keeping their
  // median. A run covers every paragraph. Generated JavaScript calls each generated function once per block per run, and
  // JavaScriptCore optimizes a function after enough calls and loop iterations, so its variants need longer warmups.
  const warmUntil = performance.now() + warmupSeconds * 1000
  let warmupRuns = 0
  for (; warmupRuns < 3 || performance.now() < warmUntil; warmupRuns++) prepared.run()
  const samples: number[] = []
  const runsPerSample: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    let runs = 0
    const started = performance.now()
    do {
      prepared.run()
      runs++
    } while (performance.now() - started < 300)
    samples.push((performance.now() - started) * 1000 / (runs * count))
    runsPerSample.push(runs)
  }
  verify(variant, prepared, expected)
  const microsecondsPerParagraph = median(samples)
  return {
    variant, size, count, width, warmupSeconds, warmupRuns, verified: prepared.lineCounts() !== null,
    totalLines: expected.reduce((total, lines) => total + lines, 0),
    prepareMilliseconds,
    ...prepared.details,
    microsecondsPerParagraph,
    millisecondsPerRun: microsecondsPerParagraph * count / 1000,
    samples, runsPerSample,
    // The largest RSS of the process so far, which Bun reports in kilobytes.
    maxRssMegabytes: process.resourceUsage().maxRSS / 1e3, loadBefore, loadAfter: loadAverage(), bun: Bun.version,
  }
}

async function runInOwnProcess(args: string[], out: string, memoryLimitMegabytes: number, timeLimitMs: number) {
  const started = performance.now()
  const child = Bun.spawn(['bun', import.meta.path, ...args], {stdout: 'pipe', stderr: 'pipe'})
  let polledPeakMegabytes = 0
  let killedFor: string | undefined
  const poll = setInterval(() => {
    const megabytes = Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(child.pid)]).stdout.toString().trim()) / 1e3
    polledPeakMegabytes = Math.max(polledPeakMegabytes, megabytes)
    if (killedFor !== undefined) return
    if (megabytes > memoryLimitMegabytes) killedFor = `RSS above ${memoryLimitMegabytes} MB after ${Math.round(performance.now() - started)} ms`
    else if (performance.now() - started > timeLimitMs) killedFor = `time above ${timeLimitMs} ms`
    if (killedFor !== undefined) child.kill('SIGKILL')
  }, 200)
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearInterval(poll)
  const common = {args, polledPeakMegabytes: Math.round(polledPeakMegabytes), wallMs: Math.round(performance.now() - started), date: new Date().toISOString()}
  const record = exitCode === 0
    ? {...JSON.parse(stdout.trim().split('\n').at(-1)!) as object, ...common}
    : {...common, failed: true, exitCode, killedFor, stderr: stderr.slice(-2000), loadAfter: loadAverage()}
  appendFileSync(out, `${JSON.stringify(record)}\n`)
  console.log(JSON.stringify(record).slice(0, 300))
}

if (import.meta.main) {
  const [command, first, second, third] = process.argv.slice(2)
  const width = Number(argument('--width') ?? 320)
  const warmupSeconds = Number(argument('--warmup-seconds') ?? 1)
  if (command === 'one') {
    console.log(JSON.stringify(timeOne(first!, second as ParagraphSize, Number(third), width, warmupSeconds)))
  } else if (command === 'all') {
    const out = argument('--out')
    if (out === undefined) throw new Error('all needs --out <file.jsonl>')
    const variants = argument('--variants')?.split(',') ?? allVariants
    const sizes = (argument('--sizes')?.split(',') ?? ['short', 'long']) as ParagraphSize[]
    const count = Number(argument('--count') ?? 1024)
    const processes = Number(argument('--processes') ?? 3)
    const memoryLimitMegabytes = Number(argument('--memory-limit-mb') ?? 16_000)
    const timeLimitMs = Number(argument('--time-limit-seconds') ?? 600) * 1000
    for (const size of sizes) {
      for (const variant of variants) {
        for (let index = 0; index < processes; index++) {
          await runInOwnProcess(['one', variant, size, String(count), '--width', String(width), '--warmup-seconds', String(warmupSeconds)], out, memoryLimitMegabytes, timeLimitMs)
        }
      }
    }
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
