// CPU timings to compare with the GPU tree. Every variant lays out the same P paragraphs of n break points as the page,
// plan.ts's batchParagraphs(n, P), alternating between 300 and 340 px from one run to the next, and gives every
// paragraph's breaks and total cost:
// - reference: reference.ts's knuthPlass, once per paragraph
// - typed: plan.ts's layOutTyped over the positions in one Int32Array
// - chain: program.ts's chain form through createTensorEvaluator, writing each paragraph's cells and evaluating once per
//   paragraph
// One variant in this process, which prints one JSON line:
//   bun lab/knuth-plass/gpu/cpu-time.ts one typed 256 32 1000
// Every size of the listed variants, each in its own process with an RSS limit and a time limit, appending one JSON line
// per process to a file:
//   bun lab/knuth-plass/gpu/cpu-time.ts all --out <file.jsonl> [--variants reference,typed,chain] [--sizes 64:8:1,256:8:1000]
//     [--processes 3] [--memory-limit-mb 16000] [--time-limit-seconds 900]
import {appendFileSync} from 'node:fs'
import type {Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {type KnuthPlass, buildKnuthPlass, writeParagraph} from '../program.ts'
import {knuthPlass} from '../reference.ts'
import {batchParagraphs, layOutTyped, writePositions} from './plan.ts'

type Variant = 'reference' | 'typed' | 'chain'
const widths = [300, 340] as const

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()

// The roots report.ts compiles: no next-state values, then the output's leaves in field order.
const rootsOf = (built: KnuthPlass): Wire[] =>
  [...built.nextSource, built.output.totalCost, built.output.windowOverflowCount, ...built.output.chosen, ...built.output.costs, ...built.output.predecessors]

// 1 s and at least 5 runs of warmup, then 7 samples of at least 300 ms each, in µs per run.
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

function timeOne(variant: Variant, breaks: number, window: number, count: number) {
  const loadBefore = loadAverage()
  const paragraphs = batchParagraphs(breaks, count)
  const solutions = widths.map(width => paragraphs.map(paragraph => knuthPlass(paragraph, width, window)))
  const totals = solutions.map(list => list.map(solution => solution.totalCost))
  const lines = solutions.map(list => list.reduce((total, solution) => total + solution.breaks.length, 0))
  let runIndex = 0
  let run: () => void
  let buildMs = 0
  let compileMs = 0
  switch (variant) {
    case 'reference':
      run = () => {
        const widthIndex = runIndex++ % 2
        for (let paragraph = 0; paragraph < count; paragraph++) {
          if (knuthPlass(paragraphs[paragraph]!, widths[widthIndex]!, window).totalCost !== totals[widthIndex]![paragraph]) throw new Error('the reference changed its total')
        }
      }
      break
    case 'typed': {
      const positions = new Int32Array(count * 2 * breaks)
      writePositions(paragraphs, positions)
      const costs = new Float64Array(breaks + 1)
      const predecessors = new Int32Array(breaks + 1)
      const breakPoints = new Int32Array(count * breaks)
      const typedTotals = new Float64Array(count)
      const layOut = (widthIndex: number) => {
        const written = layOutTyped(positions, count, breaks, widths[widthIndex]!, window, costs, predecessors, breakPoints, typedTotals)
        if (written !== lines[widthIndex]) throw new Error('the typed loop changed its line count')
        for (let paragraph = 0; paragraph < count; paragraph++) if (typedTotals[paragraph] !== totals[widthIndex]![paragraph]) throw new Error('the typed loop changed its total')
      }
      // Every break of every paragraph, before timing.
      for (const widthIndex of [0, 1]) {
        layOut(widthIndex)
        let at = 0
        for (const solution of solutions[widthIndex]!) {
          const fromTheEnd = [...solution.breaks].reverse()
          for (const point of fromTheEnd) if (breakPoints[at++] !== point) throw new Error('the typed loop\'s breaks differ from the reference')
        }
      }
      run = () => layOut(runIndex++ % 2)
      break
    }
    case 'chain': {
      const buildStarted = performance.now()
      const built = buildKnuthPlass({breakCapacity: breaks, window}, 'chain')
      buildMs = performance.now() - buildStarted
      const source = new Float32Array(built.initialSource)
      const compileStarted = performance.now()
      const evaluate = built.circuit.createTensorEvaluator(rootsOf(built))
      compileMs = performance.now() - compileStarted
      const totalCostPosition = built.nextSource.length
      const chosenPosition = totalCostPosition + 2
      // Every chosen bit and every cost of every paragraph at both widths.
      const checkAll = () => {
        for (const widthIndex of [0, 1]) {
          paragraphs.forEach((paragraph, index) => {
            writeParagraph(source, built, paragraph, widths[widthIndex]!)
            const values = evaluate(source)
            const chosen: number[] = []
            for (let at = 0; at < breaks; at++) if (values[chosenPosition + at] === 1) chosen.push(at + 1)
            const costs = Array.from(values.subarray(chosenPosition + breaks, chosenPosition + 2 * breaks + 1))
            const expected = solutions[widthIndex]![index]!
            if (chosen.join() !== expected.breaks.join() || costs.join() !== expected.costs.join()) throw new Error('the chain\'s breaks or costs differ from the reference')
          })
        }
      }
      checkAll()
      run = () => {
        const widthIndex = runIndex++ % 2
        for (let paragraph = 0; paragraph < count; paragraph++) {
          writeParagraph(source, built, paragraphs[paragraph]!, widths[widthIndex]!)
          if (evaluate(source)[totalCostPosition] !== totals[widthIndex]![paragraph]) throw new Error('the chain changed its total')
        }
      }
      const result = sample(run)
      checkAll()
      return record(result)
    }
  }
  const result = sample(run)
  return record(result)

  function record(result: ReturnType<typeof sample>) {
    return {
      variant, breaks, window, paragraphs: count, verified: true, buildMs, compileMs,
      medianMilliseconds: result.medianMicroseconds / 1000, microsecondsPerParagraph: result.medianMicroseconds / count, samples: result.samples,
      // The largest RSS of the process so far, which Bun reports in kilobytes.
      maxRssMegabytes: process.resourceUsage().maxRSS / 1e3, loadBefore, loadAfter: loadAverage(), bun: Bun.version,
    }
  }
}

// The same sizes as run.ts's defaultSizes, and the chain up to 1,024 break points and 1,000 paragraphs, plus one attempt
// at 4,096 break points, which records where the chain stops.
const defaultSizes = (variant: Variant) => {
  const singles = [64, 256, 1024, 4096].flatMap(breaks => [8, 16, 32].map(window => ({breaks, window, paragraphs: 1})))
  const batches = [
    ...[10, 100, 1000].flatMap(paragraphs => [8, 16, 32].map(window => ({breaks: 256, window, paragraphs}))),
    {breaks: 256, window: 8, paragraphs: 3000}, {breaks: 256, window: 16, paragraphs: 3000}, {breaks: 256, window: 8, paragraphs: 10_000},
  ]
  if (variant !== 'chain') return [...singles, ...batches]
  return [...singles.filter(size => size.breaks <= 1024), {breaks: 4096, window: 8, paragraphs: 1}, ...batches.filter(size => size.paragraphs <= 1000)]
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
  const result = exitCode === 0
    ? {...JSON.parse(stdout.trim().split('\n').at(-1)!) as object, ...common}
    : {...common, failed: true, exitCode, killedFor, stderr: stderr.slice(-2000), loadAfter: loadAverage()}
  appendFileSync(out, `${JSON.stringify(result)}\n`)
  console.log(JSON.stringify(result).slice(0, 300))
  return result
}

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2)
  if (command === 'one') {
    console.log(JSON.stringify(timeOne(first as Variant, Number(second), Number(third), Number(fourth))))
  } else if (command === 'all') {
    const out = argument('--out')
    if (out === undefined) throw new Error('all needs --out <file.jsonl>')
    const variants = (argument('--variants') ?? 'reference,typed,chain').split(',') as Variant[]
    const processes = Number(argument('--processes') ?? 3)
    const memoryLimitMegabytes = Number(argument('--memory-limit-mb') ?? 16_000)
    const timeLimitMs = Number(argument('--time-limit-seconds') ?? 900) * 1000
    // --sizes lists the sizes to time, which needn't be default sizes, e.g. 256:8:30.
    const listed = argument('--sizes')?.split(',').map(entry => {
      const [breaks, window, paragraphs] = entry.split(':').map(Number)
      return {breaks: breaks!, window: window!, paragraphs: paragraphs!}
    })
    for (const variant of variants) {
      const sizes = listed ?? defaultSizes(variant)
      for (const {breaks, window, paragraphs} of sizes) {
        for (let index = 0; index < processes; index++) {
          const result = await runInOwnProcess(['one', variant, String(breaks), String(window), String(paragraphs)], out, memoryLimitMegabytes, timeLimitMs)
          // A size that fails once, e.g. the chain past its capacity, fails the same way in every process.
          if ('failed' in result) break
        }
      }
    }
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
