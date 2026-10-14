// CPU timings to compare with the GPU tree in page.ts. Every variant computes the reach bits at every position, the bits
// the GPU reads back:
// - js-dense: denseReach, a plain JavaScript loop over the automaton, S × S reads per code point
// - js-bitmask: bitmaskReach, the same loop over 32-bit rows, S word operations per code point
// - data-reverse: form (a)'s program with the reverse pass's bits as roots, through createTensorEvaluator
// - tree-ends: form (c)'s program with longestEnds as roots, through createTensorEvaluator
// One variant in this process, which prints one JSON line:
//   bun lab/regex-search/gpu/cpu-time.ts one js-dense 32 65536 [--bits <folder>]
// Every size of the listed variants, each in its own process with a memory limit and a time limit, appending one JSON line
// per process to a file:
//   bun lab/regex-search/gpu/cpu-time.ts all --out <file.jsonl> --variants js-dense,data-reverse [--processes 3] [--bits <folder>] [--large]
//     [--sizes 32:256,16:1024] [--memory-limit-mb 16000] [--time-limit-seconds 600]
// --bits writes the variant's reach words and the reference's, from tree-inputs.ts's productTreeInputs, into
// reach-<variant>-<S>-<N>.bin files, which page.ts compares with every GPU readback. --large adds form (c) at S = 16 and
// 1,024 code points, which needed 8.7 GB in an earlier run.
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import type {Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {buildDataSearch, writePattern} from '../../../src/json-search/regex/data-program.ts'
import {writeText} from '../../../src/json-search/regex/host.ts'
import {compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {patternsByStates} from '../report.ts'
import {productTreeInputs} from '../tree-inputs.ts'
import {buildTreeSearch} from '../tree-program.ts'
import {bitmaskInputs, bitmaskReach, classInputs, denseReach, packReach, textOf} from './automaton-inputs.ts'

type Variant = 'js-dense' | 'js-bitmask' | 'data-reverse' | 'tree-ends'
const allVariants: readonly Variant[] = ['js-dense', 'js-bitmask', 'data-reverse', 'tree-ends']
const allTextLengths = [256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536]

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()
const sameWords = (left: Uint32Array, right: Uint32Array) => left.length === right.length && left.every((word, index) => word === right[index])

type Prepared = {run: () => void, read: () => Uint32Array, buildMs: number, compileMs: number, exactEnds?: () => boolean}

function prepare(variant: Variant, states: number, textLength: number, reference: ReturnType<typeof productTreeInputs>): Prepared {
  const compiled = compilePattern(patternsByStates[states]!)
  const codePoints = textOf(textLength)
  switch (variant) {
    case 'js-dense': {
      const inputs = classInputs(compiled, codePoints, states)
      const reach = new Uint8Array(textLength * states)
      return {run: () => denseReach(inputs, reach), read: () => packReach(reach, states, textLength), buildMs: 0, compileMs: 0}
    }
    case 'js-bitmask': {
      const inputs = bitmaskInputs(classInputs(compiled, codePoints, states))
      const words = new Uint32Array(textLength)
      return {run: () => bitmaskReach(inputs, words), read: () => words, buildMs: 0, compileMs: 0}
    }
    case 'data-reverse':
    case 'tree-ends': {
      const capacity = {states, classes: 16, boundaries: 32, textLength}
      const buildStarted = performance.now()
      const built = variant === 'data-reverse' ? buildDataSearch(capacity) : buildTreeSearch(capacity, 'brent-kung')
      const buildMs = performance.now() - buildStarted
      const source = new Float32Array(built.initialSource)
      writePattern(source, built, compiled)
      writeText(source, built.cells.text, codePoints)
      // Form (a): notReachAt[j][s], a wire or a bit the builder knows. Form (c): longestEnds[j][s].
      const bits = 'notReachAt' in built ? built.notReachAt.flat() : built.longestEnds.flat()
      const roots = bits.filter((bit): bit is Wire => typeof bit !== 'boolean')
      const compileStarted = performance.now()
      const evaluate = built.circuit.createTensorEvaluator(roots)
      const compileMs = performance.now() - compileStarted
      let outputs: Float32Array = new Float32Array(0)
      const valuesAtPositions = () => {
        let rootIndex = 0
        return bits.map(bit => typeof bit === 'boolean' ? Number(bit) : outputs[rootIndex++]!)
      }
      const read = () => {
        const values = valuesAtPositions()
        const words = new Uint32Array(textLength)
        values.forEach((value, index) => {
          // Form (a) holds "doesn't reach" bits, and form (c) holds ends, where 0 means none.
          const reaches = variant === 'data-reverse' ? value === 0 : value > 0
          if (reaches) words[Math.floor(index / states)]! |= 1 << (index % states)
        })
        if (variant === 'data-reverse' && values.some(value => value !== 0 && value !== 1)) throw new Error('a reverse pass bit is not 0 or 1')
        return words
      }
      const exactEnds = variant === 'tree-ends' ? () => valuesAtPositions().every((value, index) => value === reference.longestEnds[index]) : undefined
      return {run: () => { outputs = evaluate(source) }, read, buildMs, compileMs, ...(exactEnds === undefined ? {} : {exactEnds})}
    }
  }
}

function timeOne(variant: Variant, states: number, textLength: number, bitsFolder: string | undefined) {
  const loadBefore = loadAverage()
  const compiled = compilePattern(patternsByStates[states]!)
  const reference = productTreeInputs(compiled, textOf(textLength), {states, textLength})
  const referenceWords = packReach(reference.reach, states, textLength)
  const prepared = prepare(variant, states, textLength, reference)
  prepared.run()
  const firstWords = prepared.read()
  if (!sameWords(firstWords, referenceWords)) throw new Error(`${variant} at S = ${states}, N = ${textLength} doesn't give the reference reach bits`)
  if (prepared.exactEnds !== undefined && !prepared.exactEnds()) throw new Error(`form (c)'s longestEnds differ from productTreeInputs at S = ${states}, N = ${textLength}`)
  if (bitsFolder !== undefined) {
    mkdirSync(bitsFolder, {recursive: true})
    writeFileSync(join(bitsFolder, `reach-reference-${states}-${textLength}.bin`), referenceWords)
    writeFileSync(join(bitsFolder, `reach-${variant}-${states}-${textLength}.bin`), firstWords)
  }
  // The same timing loop as report.ts: 1 s of warmup, then 7 samples of at least 300 ms each, keeping their median.
  const warmUntil = performance.now() + 1000
  for (let warm = 0; warm < 5 || performance.now() < warmUntil; warm++) prepared.run()
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    let iterations = 0
    const started = performance.now()
    do {
      prepared.run()
      iterations++
    } while (performance.now() - started < 300)
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  if (!sameWords(prepared.read(), referenceWords)) throw new Error(`${variant} at S = ${states}, N = ${textLength} gave different bits after timing`)
  return {
    variant, states, textLength, pattern: compiled.pattern, verified: true, exactEnds: prepared.exactEnds === undefined ? undefined : true,
    buildMs: prepared.buildMs, compileMs: prepared.compileMs, medianMicroseconds: median(samples), samples,
    // The largest RSS of the process so far, which Bun reports in kilobytes.
    maxRssMegabytes: process.resourceUsage().maxRSS / 1e3, loadBefore, loadAfter: loadAverage(), bun: Bun.version,
  }
}

function sizesOf(variant: Variant, large: boolean): {states: number, textLength: number}[] {
  switch (variant) {
    case 'js-dense':
    case 'js-bitmask':
      return [8, 16, 32].flatMap(states => allTextLengths.map(textLength => ({states, textLength})))
    case 'data-reverse':
      // compileTensorProgram allocates an Int32Array of the circuit's whole width for every layer, and form (a) has 8N − 2
      // layers, so 16,384 code points would allocate about 131,000 × 15 MB at S = 8.
      return [8, 16, 32].flatMap(states => [256, 512, 1024].map(textLength => ({states, textLength})))
    case 'tree-ends':
      return [{states: 8, textLength: 256}, {states: 8, textLength: 1024}, {states: 16, textLength: 256}, {states: 32, textLength: 256}, ...(large ? [{states: 16, textLength: 1024}] : [])]
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
  console.log(JSON.stringify(record).slice(0, 400))
}

if (import.meta.main) {
  const [command, first, second, third] = process.argv.slice(2)
  const bitsFolder = argument('--bits')
  if (command === 'one') {
    console.log(JSON.stringify(timeOne(first as Variant, Number(second), Number(third), bitsFolder)))
  } else if (command === 'all') {
    const out = argument('--out')
    if (out === undefined) throw new Error('all needs --out <file.jsonl>')
    const variants = (argument('--variants')?.split(',') ?? allVariants) as Variant[]
    const processes = Number(argument('--processes') ?? 3)
    const memoryLimitMegabytes = Number(argument('--memory-limit-mb') ?? 16_000)
    const timeLimitMs = Number(argument('--time-limit-seconds') ?? 600) * 1000
    // --sizes 32:256,16:1024 keeps only those sizes.
    const only = argument('--sizes')?.split(',').map(entry => entry.split(':').map(Number))
    const kept = (size: {states: number, textLength: number}) => only === undefined || only.some(([states, textLength]) => states === size.states && textLength === size.textLength)
    for (const variant of variants) {
      for (const {states, textLength} of sizesOf(variant, process.argv.includes('--large')).filter(kept)) {
        for (let index = 0; index < processes; index++) {
          // Only the first process writes bits.
          const bitArguments = bitsFolder !== undefined && index === 0 ? ['--bits', bitsFolder] : []
          await runInOwnProcess(['one', variant, String(states), String(textLength), ...bitArguments], out, memoryLimitMegabytes, timeLimitMs)
        }
      }
    }
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
