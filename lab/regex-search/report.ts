// The measurements in README.md. With no arguments, runs every variant in its own process and prints markdown tables:
//   bun lab/regex-search/report.ts
// One variant, which prints one JSON line:
//   bun lab/regex-search/report.ts sizes data 32 1024        cells, operations, layers, stored weights, build and compile times
//   bun lab/regex-search/report.ts time data 32 1024 raw     µs per evaluation of the compiled program alone
//   bun lab/regex-search/report.ts time data 32 1024 full    µs per evaluation through createEvaluator, with its checks
//   bun lab/regex-search/report.ts recompile 32 1024         form (b): ms from a new pattern to its first evaluation
// The form builtin-expensive is form (b) with expensivePattern instead of the pattern from patternsByStates, e.g.
//   bun lab/regex-search/report.ts sizes builtin-expensive 32 1024
//   bun lab/regex-search/report.ts recompile 32 1024 expensive
// The forms tree and tree-sklansky are form (c) with Brent-Kung's and Sklansky's networks, e.g.
//   bun lab/regex-search/report.ts sizes tree 8 1024
import {createEvaluator} from '../../src/runtime/cells.ts'
import type {Wire} from '../../src/runtime/numeric-ui-core.ts'
import {buildBuiltInSearch} from './builtin-program.ts'
import {buildDataSearch, writePattern} from './data-program.ts'
import {codePointsOf, writeText} from './host.ts'
import {compilePattern} from './pattern.ts'
import {automatonMatches} from './reference.ts'
import {sampleText} from './sample-text.ts'
import {buildTreeSearch} from './tree-program.ts'

// One pattern per state count, each with exactly that many states, 13 or fewer classes and 32 or fewer boundaries.
export const patternsByStates: Record<number, string> = {
  8: '(the|an?) [a-z]+',
  16: '(the|an?|some) [a-z]+(ing)?s?',
  32: '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ',
}
const classes = 16
const boundaries = 32

// Form (b)'s size depends on the pattern, even within the capacity. The most expensive pattern I found within 32 states,
// 16 classes and 32 class boundaries: a chain of 31 different classes, each made of 14 or 15 of the 16 separate letters
// acegikmoqsuwyACE, i.e. [cegikmoqsuwyACE]*[aegikmoqsuwyACE]*…[acegikmoqsuwyE]*[acegikmoqsuwyA]. Different classes and
// different targets for every state keep the builder's deduplication map from giving states the same operations, and
// every membership sum has about 30 terms.
const separateLetters = 'acegikmoqsuwyACE'
const chainClasses = [
  ...Array.from({length: 16}, (_, index) => separateLetters.slice(0, index) + separateLetters.slice(index + 1)),
  ...Array.from({length: 15}, (_, index) => separateLetters.slice(0, index) + separateLetters.slice(index + 2)),
]
export const expensivePattern = `${chainClasses.slice(0, 30).map(letters => `[${letters}]*`).join('')}[${chainClasses[30]}]`

type Form = 'data' | 'builtin' | 'builtin-expensive' | 'tree' | 'tree-sklansky'
const formNames: Record<Form, string> = {
  'data': '(a) data',
  'builtin': '(b) built in',
  'builtin-expensive': '(b) built in, expensive pattern',
  'tree': '(c) tree, Brent-Kung',
  'tree-sklansky': '(c) tree, Sklansky',
}
const patternOf = (form: Form, states: number) => form === 'builtin-expensive' ? expensivePattern : patternsByStates[states]!

const textOf = (textLength: number) => codePointsOf(sampleText.repeat(Math.ceil(textLength / sampleText.length))).slice(0, textLength)
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!

function prepare(form: Form, states: number, textLength: number) {
  const pattern = patternOf(form, states)
  const compiled = compilePattern(pattern)
  const codePoints = textOf(textLength)
  const capacity = {states, classes, boundaries, textLength}
  const started = performance.now()
  const prepared = form === 'data'
    ? {form, built: buildDataSearch(capacity)} as const
    : form === 'tree' || form === 'tree-sklansky'
      ? {form, built: buildTreeSearch(capacity, form === 'tree' ? 'brent-kung' : 'sklansky')} as const
      : {form, built: buildBuiltInSearch(compiled, textLength)} as const
  const buildMs = performance.now() - started
  const source = new Float32Array(prepared.built.initialSource)
  if (prepared.form === 'data' || prepared.form === 'tree' || prepared.form === 'tree-sklansky') writePattern(source, prepared.built, compiled)
  writeText(source, prepared.built.cells.text, codePoints)
  return {...prepared, source, buildMs, compiled, codePoints}
}

// The roots createEvaluator compiles: every next-state value, then the output's leaves in field order.
const rootsOf = (built: ReturnType<typeof prepare>['built']): Wire[] =>
  [...built.nextSource, ...built.output.highlighted, ...built.output.starts, built.output.matchCount]

function sizes(form: Form, states: number, textLength: number) {
  const prepared = prepare(form, states, textLength)
  const {built, buildMs, compiled} = prepared
  const started = performance.now()
  const program = built.circuit.compileTensorProgram(rootsOf(built))
  const compileMs = performance.now() - started
  // Form (a): what a new pattern costs before the evaluation, i.e. compiling the pattern and writing its cells.
  let patternWriteMicroseconds: number | undefined
  if (prepared.form === 'data') {
    const source = new Float32Array(prepared.built.initialSource)
    const writeStarted = performance.now()
    for (let index = 0; index < 100; index++) writePattern(source, prepared.built, compilePattern(patternsByStates[states]!))
    patternWriteMicroseconds = (performance.now() - writeStarted) * 10
  }
  return {
    form, states, textLength, pattern: compiled.pattern,
    automatonStates: compiled.automaton.stateCount,
    automatonClasses: compiled.partition.classCount,
    automatonBoundaries: compiled.partition.boundaries.length,
    cells: built.circuit.sourceSize,
    builtOperations: built.circuit.operations.length,
    liveOperations: program.wireOrder.length - built.circuit.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    indexReads: program.layers.reduce((total, layer) => total + layer.indexReads.length, 0),
    buildMs, compileMs, patternWriteMicroseconds,
    rssMegabytes: process.memoryUsage().rss / 1e6,
    // The largest RSS of the process so far, which Bun reports in kilobytes.
    maxRssMegabytes: process.resourceUsage().maxRSS / 1e3,
  }
}

function time(form: Form, states: number, textLength: number, mode: 'raw' | 'full') {
  const {built, source, compiled, codePoints} = prepare(form, states, textLength)
  const expectedMatchCount = automatonMatches(compiled, codePoints).length
  let evaluate: (values: Float32Array) => unknown
  if (mode === 'raw') {
    const roots = rootsOf(built)
    const evaluateRoots = built.circuit.createTensorEvaluator(roots)
    const countPosition = roots.length - 1
    evaluate = values => {
      const result = evaluateRoots(values)
      if (result[countPosition] !== expectedMatchCount) throw new Error(`matchCount ${result[countPosition]}, expected ${expectedMatchCount}`)
      return result
    }
  } else {
    const evaluateChecked = createEvaluator(built)
    evaluate = values => {
      const result = evaluateChecked(values)
      if (result.output.matchCount !== expectedMatchCount) throw new Error(`matchCount ${result.output.matchCount}, expected ${expectedMatchCount}`)
      return result
    }
  }
  const warmUntil = performance.now() + 1000
  for (let warm = 0; warm < 5 || performance.now() < warmUntil; warm++) evaluate(source)
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    let iterations = 0
    const started = performance.now()
    do {
      evaluate(source)
      iterations++
    } while (performance.now() - started < 300)
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  return {form, states, textLength, mode, expectedMatchCount, medianMicroseconds: median(samples), samples}
}

type RecompileRun = {patternMs: number, buildMs: number, compileMs: number, firstEvaluationMs: number, totalMs: number}

function recompile(states: number, textLength: number, expensive: boolean) {
  const pattern = expensive ? expensivePattern : patternsByStates[states]!
  const codePoints = textOf(textLength)
  const runs: RecompileRun[] = []
  for (let run = 0; run < 6; run++) {
    const started = performance.now()
    const compiled = compilePattern(pattern)
    const afterPattern = performance.now()
    const built = buildBuiltInSearch(compiled, textLength)
    const afterBuild = performance.now()
    const evaluate = createEvaluator(built)
    const afterCompile = performance.now()
    const source = new Float32Array(built.initialSource)
    writeText(source, built.cells.text, codePoints)
    evaluate(source)
    const afterEvaluation = performance.now()
    runs.push({patternMs: afterPattern - started, buildMs: afterBuild - afterPattern, compileMs: afterCompile - afterBuild, firstEvaluationMs: afterEvaluation - afterCompile, totalMs: afterEvaluation - started})
  }
  // The first run warms the JIT, e.g. the builder's first call.
  const measured = runs.slice(1)
  const field = (name: keyof RecompileRun) => median(measured.map(run => run[name]))
  return {states, textLength, expensive, patternMs: field('patternMs'), buildMs: field('buildMs'), compileMs: field('compileMs'), firstEvaluationMs: field('firstEvaluationMs'), totalMs: field('totalMs')}
}

function runInOwnProcess<Result>(args: string[]): Result {
  const result = Bun.spawnSync(['bun', import.meta.path, ...args], {stdout: 'pipe', stderr: 'inherit'})
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} exited with ${result.exitCode}`)
  const lines = result.stdout.toString().trim().split('\n')
  return JSON.parse(lines.at(-1)!) as Result
}

const format = (value: number, digits = 0) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})

function all() {
  const variants: {form: Form, states: number, textLength: number}[] = [
    ...(['data', 'builtin'] as const).flatMap(form => [8, 16, 32].flatMap(states => [256, 1024].map(textLength => ({form, states, textLength})))),
    ...[256, 1024].map(textLength => ({form: 'builtin-expensive' as const, states: 32, textLength})),
    // Form (c) with Brent-Kung's network at every size that fits in memory, and with Sklansky's at S = 8. S = 32 at 1,024
    // code points would build about 43 million operations.
    ...[8, 16].flatMap(states => [256, 1024].map(textLength => ({form: 'tree' as const, states, textLength}))),
    {form: 'tree', states: 32, textLength: 256},
    ...[256, 1024].map(textLength => ({form: 'tree-sklansky' as const, states: 8, textLength})),
  ]
  const sizeRows: string[] = []
  const timeRows: string[] = []
  for (const {form, states, textLength} of variants) {
    const args = [form, String(states), String(textLength)]
    const size = runInOwnProcess<ReturnType<typeof sizes>>(['sizes', ...args])
    console.error(`sizes ${args.join(' ')}: ${size.liveOperations} live operations`)
    sizeRows.push(`| ${formNames[form]} | ${states} | ${format(textLength)} | ${format(size.cells)} | ${format(size.liveOperations)} | ${format(size.layers)} | ${format(size.storedWeights)} | ${format(size.indexReads)} | ${format(size.buildMs)} | ${format(size.compileMs)} | ${format(size.rssMegabytes)} |`)
    const raw = [0, 1, 2].map(() => runInOwnProcess<ReturnType<typeof time>>(['time', ...args, 'raw']).medianMicroseconds)
    const full = [0, 1, 2].map(() => runInOwnProcess<ReturnType<typeof time>>(['time', ...args, 'full']).medianMicroseconds)
    console.error(`time ${args.join(' ')}: raw ${raw.map(value => format(value)).join(', ')}, full ${full.map(value => format(value)).join(', ')}`)
    const spread = (values: number[]) => `${format(median(values))} (${format(Math.min(...values))} to ${format(Math.max(...values))})`
    timeRows.push(`| ${formNames[form]} | ${states} | ${format(textLength)} | ${spread(raw)} | ${spread(full)} | ${format(median(raw) / (size.liveOperations / 1e3), 1)} |`)
  }
  const recompileVariants = [
    ...[8, 16, 32].flatMap(states => [256, 1024].map(textLength => ({states, textLength, expensive: false}))),
    ...[256, 1024].map(textLength => ({states: 32, textLength, expensive: true})),
  ]
  const recompileRows = recompileVariants.map(({states, textLength, expensive}) => {
    const result = runInOwnProcess<ReturnType<typeof recompile>>(['recompile', String(states), String(textLength), ...(expensive ? ['expensive'] : [])])
    return `| ${states}${expensive ? ', expensive pattern' : ''} | ${format(textLength)} | ${format(result.patternMs, 2)} | ${format(result.buildMs)} | ${format(result.compileMs)} | ${format(result.firstEvaluationMs, 1)} | ${format(result.totalMs)} |`
  })
  console.log('| Form | S | N | Cells | Live operations | Layers | Stored weights | Index reads | Build ms | Compile ms | RSS MB |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  console.log(sizeRows.join('\n'))
  console.log('\n| Form | S | N | µs per evaluation, program alone | µs through createEvaluator | µs per 1,000 live operations |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  console.log(timeRows.join('\n'))
  console.log('\n| S | N | Compile pattern ms | Build ms | Compile program ms | First evaluation ms | Total ms |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  console.log(recompileRows.join('\n'))
}

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2)
  if (command === undefined) {
    all()
  } else if (command === 'sizes') {
    console.log(JSON.stringify(sizes(first as Form, Number(second), Number(third))))
  } else if (command === 'time') {
    console.log(JSON.stringify(time(first as Form, Number(second), Number(third), fourth === 'raw' ? 'raw' : 'full')))
  } else if (command === 'recompile') {
    console.log(JSON.stringify(recompile(Number(first), Number(second), third === 'expensive')))
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
