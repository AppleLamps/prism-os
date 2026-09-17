// The CPU numbers in README.md: sizes and µs per evaluation of both programs, and µs per call of the JavaScript
// reference, each variant in its own process. Every variant lays out timingParagraph(n) at 300 px.
// One variant, which prints one JSON line:
//   bun lab/knuth-plass/report.ts one sizes chain 1024 32       live operations, layers, stored weights, build and compile ms, peak RSS
//   bun lab/knuth-plass/report.ts one time tree 256 16          µs per evaluation through createTensorEvaluator, which checks source ranges
//   bun lab/knuth-plass/report.ts one time reference 256 16     µs per call of reference.ts's knuthPlass
// Every variant, each in its own process with an RSS limit and a time limit, appending one JSON line per process:
//   bun lab/knuth-plass/report.ts all --out <file.jsonl> [--forms chain,tree,reference] [--breaks 64,256,1024]
//     [--windows 8,16,32] [--processes 3] [--memory-limit-mb 16000] [--time-limit-seconds 900]
// The markdown tables from one or more such files:
//   bun lab/knuth-plass/report.ts tables <file.jsonl> [<file.jsonl> ...]
import {appendFileSync, readFileSync} from 'node:fs'
import type {Wire} from '../../src/runtime/numeric-ui-core.ts'
import {timingParagraph, timingWidth} from './paragraph.ts'
import {type KnuthPlass, type ProgramForm, buildKnuthPlass, writeParagraph} from './program.ts'
import {knuthPlass} from './reference.ts'

type Variant = ProgramForm | 'reference'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const numbers = (text: string) => text.split(',').map(Number)
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()

// The roots createEvaluator would compile: no next-state values, then the output's leaves in field order.
const rootsOf = (built: KnuthPlass): Wire[] =>
  [...built.nextSource, built.output.totalCost, built.output.windowOverflowCount, ...built.output.chosen, ...built.output.costs, ...built.output.predecessors]

function sizes(form: ProgramForm, breakCapacity: number, window: number) {
  const loadBefore = loadAverage()
  const buildStarted = performance.now()
  const built = buildKnuthPlass({breakCapacity, window}, form)
  const buildMilliseconds = performance.now() - buildStarted
  const compileStarted = performance.now()
  const program = built.circuit.compileTensorProgram(rootsOf(built))
  const compileMilliseconds = performance.now() - compileStarted
  return {
    kind: 'sizes', form, breakCapacity, window,
    cells: built.circuit.sourceSize,
    builtOperations: built.circuit.operations.length,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    indexReads: program.layers.reduce((total, layer) => total + layer.indexReads.length, 0),
    buildMilliseconds, compileMilliseconds,
    // The largest RSS of the process so far, which Bun reports in kilobytes.
    maxRssMegabytes: process.resourceUsage().maxRSS / 1e3,
    loadBefore, loadAfter: loadAverage(), bun: Bun.version,
  }
}

// 1 s and at least 5 runs of warmup, then 7 samples of at least 300 ms each.
function sample(run: () => void) {
  const warmUntil = performance.now() + 1000
  for (let warmup = 0; warmup < 5 || performance.now() < warmUntil; warmup++) run()
  const samples: number[] = []
  for (let index = 0; index < 7; index++) {
    let iterations = 0
    const started = performance.now()
    do {
      run()
      iterations++
    } while (performance.now() - started < 300)
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  return {medianMicroseconds: median(samples), samples}
}

function time(variant: Variant, breakCapacity: number, window: number) {
  const loadBefore = loadAverage()
  const paragraph = timingParagraph(breakCapacity)
  const expected = knuthPlass(paragraph, timingWidth, window)
  if (expected.windowOverflowCount !== 0) throw new Error(`the timing paragraph has lines of more than ${window} boxes at ${timingWidth} px`)
  if (variant === 'reference') {
    const result = sample(() => {
      if (knuthPlass(paragraph, timingWidth, window).totalCost !== expected.totalCost) throw new Error('the reference changed its total')
    })
    return {kind: 'time', form: variant, breakCapacity, window, lineCount: expected.breaks.length, totalCost: expected.totalCost, ...result, loadBefore, loadAfter: loadAverage(), bun: Bun.version}
  }
  const buildStarted = performance.now()
  const built = buildKnuthPlass({breakCapacity, window}, variant)
  const buildMilliseconds = performance.now() - buildStarted
  const source = new Float32Array(built.initialSource)
  writeParagraph(source, built, paragraph, timingWidth)
  const roots = rootsOf(built)
  const compileStarted = performance.now()
  const evaluate = built.circuit.createTensorEvaluator(roots)
  const compileMilliseconds = performance.now() - compileStarted
  const totalCostPosition = built.nextSource.length
  const chosenPosition = totalCostPosition + 2
  // Every chosen bit and every cost, before and after timing.
  const checkAll = () => {
    const values = evaluate(source)
    const breaks: number[] = []
    for (let index = 0; index < breakCapacity; index++) if (values[chosenPosition + index] === 1) breaks.push(index + 1)
    const costs = Array.from(values.subarray(chosenPosition + breakCapacity, chosenPosition + 2 * breakCapacity + 1))
    if (breaks.join() !== expected.breaks.join() || costs.join() !== expected.costs.join()) throw new Error('the program\'s breaks or costs differ from the reference')
  }
  checkAll()
  const result = sample(() => {
    if (evaluate(source)[totalCostPosition] !== expected.totalCost) throw new Error('the program changed its total')
  })
  checkAll()
  return {
    kind: 'time', form: variant, breakCapacity, window, lineCount: expected.breaks.length, totalCost: expected.totalCost,
    buildMilliseconds, compileMilliseconds, ...result,
    maxRssMegabytes: process.resourceUsage().maxRSS / 1e3,
    loadBefore, loadAfter: loadAverage(), bun: Bun.version,
  }
}

type Record = {
  kind?: string, form?: Variant, breakCapacity?: number, window?: number, args: string[], failed?: boolean, killedFor?: string,
  liveOperations?: number, layers?: number, storedWeights?: number, indexReads?: number, builtOperations?: number,
  buildMilliseconds?: number, compileMilliseconds?: number, maxRssMegabytes?: number, polledPeakMegabytes?: number,
  medianMicroseconds?: number, loadBefore?: string, loadAfter?: string, wallMs?: number,
}

async function runInOwnProcess(args: string[], out: string, memoryLimitMegabytes: number, timeLimitMs: number): Promise<Record> {
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
  const record: Record = exitCode === 0
    ? {...JSON.parse(stdout.trim().split('\n').at(-1)!) as object, ...common}
    : {...common, failed: true, killedFor: killedFor ?? `exit code ${exitCode}`, loadAfter: loadAverage(), ...{stderr: stderr.slice(-2000)}}
  appendFileSync(out, `${JSON.stringify(record)}\n`)
  console.log(JSON.stringify(record).slice(0, 400))
  return record
}

async function all() {
  const out = argument('--out')
  if (out === undefined) throw new Error('--out <file.jsonl> is required')
  const forms = (argument('--forms') ?? 'chain,tree,reference').split(',') as Variant[]
  const breakCounts = numbers(argument('--breaks') ?? '64,256,1024')
  const windows = numbers(argument('--windows') ?? '8,16,32')
  const processes = Number(argument('--processes') ?? 3)
  const memoryLimitMegabytes = Number(argument('--memory-limit-mb') ?? 16_000)
  const timeLimitMs = Number(argument('--time-limit-seconds') ?? 900) * 1000
  for (const breakCapacity of breakCounts) {
    for (const window of windows) {
      for (const form of forms) {
        const shape = [form, String(breakCapacity), String(window)]
        if (form !== 'reference') {
          const size = await runInOwnProcess(['one', 'sizes', ...shape], out, memoryLimitMegabytes, timeLimitMs)
          if (size.failed === true) continue
        }
        for (let index = 0; index < processes; index++) await runInOwnProcess(['one', 'time', ...shape], out, memoryLimitMegabytes, timeLimitMs)
      }
    }
  }
}

const format = (value: number, digits = 0) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})
const formatMicroseconds = (value: number) => format(value, value < 10 ? 2 : value < 100 ? 1 : 0)

function tables(files: readonly string[]) {
  const records = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record))
  const shapeOf = (record: Record) => {
    const [, kind, form, breakCapacity, window] = record.args
    return {kind: kind!, form: form as Variant, breakCapacity: Number(breakCapacity), window: Number(window)}
  }
  const matching = (kind: string, form: Variant, breakCapacity: number, window: number) => records.filter(record => {
    const shape = shapeOf(record)
    return shape.kind === kind && shape.form === form && shape.breakCapacity === breakCapacity && shape.window === window
  })
  const breakCounts = [...new Set(records.map(record => shapeOf(record).breakCapacity))].sort((left, right) => left - right)
  const windows = [...new Set(records.map(record => shapeOf(record).window))].sort((left, right) => left - right)
  console.log('| Form | n | W | Live operations | Layers | Stored weights | Index reads | Build ms | Compile ms | Peak RSS MB |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const breakCapacity of breakCounts) {
    for (const window of windows) {
      for (const form of ['chain', 'tree'] as const) {
        const size = matching('sizes', form, breakCapacity, window).at(-1)
        if (size === undefined) continue
        const shape = `| ${form} | ${format(breakCapacity)} | ${window} |`
        if (size.failed === true) console.log(`${shape} didn't build: ${size.killedFor}, ${format(size.polledPeakMegabytes ?? 0)} MB polled | | | | | | |`)
        else console.log(`${shape} ${format(size.liveOperations!)} | ${format(size.layers!)} | ${format(size.storedWeights!)} | ${format(size.indexReads!)} | ${format(size.buildMilliseconds!)} | ${format(size.compileMilliseconds!)} | ${format(size.maxRssMegabytes!)} |`)
      }
    }
  }
  console.log('\n| n | W | Chain µs | Tree µs | Reference µs | Chain µs per 1,000 live operations | Tree µs per 1,000 live operations | Load average before and after |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const breakCapacity of breakCounts) {
    for (const window of windows) {
      const cells: string[] = []
      const perThousand: string[] = []
      const loads: string[] = []
      for (const form of ['chain', 'tree', 'reference'] as const) {
        const runs = matching('time', form, breakCapacity, window).filter(record => record.failed !== true)
        const medians = runs.map(record => record.medianMicroseconds!)
        loads.push(...runs.flatMap(record => [record.loadBefore, record.loadAfter]).filter(load => load !== undefined).map(load => load.replace(/[{}]/g, '').trim().split(/\s+/)[0]!))
        cells.push(medians.length === 0 ? '' : `${formatMicroseconds(median(medians))} (${formatMicroseconds(Math.min(...medians))} to ${formatMicroseconds(Math.max(...medians))})`)
        if (form !== 'reference') {
          const size = matching('sizes', form, breakCapacity, window).at(-1)
          perThousand.push(medians.length === 0 || size?.liveOperations === undefined ? '' : format(median(medians) / (size.liveOperations / 1000), 1))
        }
      }
      if (cells.every(cell => cell === '')) continue
      const loadNumbers = loads.map(Number)
      console.log(`| ${format(breakCapacity)} | ${window} | ${cells.join(' | ')} | ${perThousand.join(' | ')} | ${loadNumbers.length === 0 ? '' : `${format(Math.min(...loadNumbers), 1)} to ${format(Math.max(...loadNumbers), 1)}`} |`)
    }
  }
}

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2)
  if (command === 'one' && first === 'sizes') console.log(JSON.stringify(sizes(second as ProgramForm, Number(third), Number(fourth))))
  else if (command === 'one' && first === 'time') console.log(JSON.stringify(time(second as Variant, Number(third), Number(fourth))))
  else if (command === 'all') await all()
  else if (command === 'tables') tables(process.argv.slice(3))
  else throw new Error(`unknown command ${process.argv.slice(2).join(' ')}`)
}
