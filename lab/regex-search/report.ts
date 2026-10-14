// The measurements in README.md. With no arguments, runs every variant in its own process and prints markdown tables:
//   bun lab/regex-search/report.ts
// One variant, which prints one JSON line:
//   bun lab/regex-search/report.ts sizes data 32 1024        cells, operations, layers, stored weights, build and compile times
//   bun lab/regex-search/report.ts time data 32 1024 raw     µs per evaluation of the compiled program alone
//   bun lab/regex-search/report.ts time data 32 1024 full    µs per evaluation through createEvaluator, with its checks
// The form data is form (a). The forms tree and tree-sklansky are form (c) with Brent-Kung's and Sklansky's networks, e.g.
//   bun lab/regex-search/report.ts sizes tree 8 1024
import {createEvaluator} from '../../src/runtime/cells.ts'
import type {Wire} from '../../src/runtime/numeric-ui-core.ts'
import {buildDataSearch, writePattern} from '../../src/json-search/regex/data-program.ts'
import {codePointsOf, writeText} from '../../src/json-search/regex/host.ts'
import {compilePattern} from '../../src/json-search/regex/pattern.ts'
import {automatonMatches} from '../../tests/json-search/regex/reference.ts'
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

type Form = 'data' | 'tree' | 'tree-sklansky'
const formNames: Record<Form, string> = {
  'data': '(a) data',
  'tree': '(c) tree, Brent-Kung',
  'tree-sklansky': '(c) tree, Sklansky',
}

const textOf = (textLength: number) => codePointsOf(sampleText.repeat(Math.ceil(textLength / sampleText.length))).slice(0, textLength)
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!

function prepare(form: Form, states: number, textLength: number) {
  const compiled = compilePattern(patternsByStates[states]!)
  const codePoints = textOf(textLength)
  const capacity = {states, classes, boundaries, textLength}
  const started = performance.now()
  const prepared = form === 'data'
    ? {form, built: buildDataSearch(capacity)} as const
    : {form, built: buildTreeSearch(capacity, form === 'tree' ? 'brent-kung' : 'sklansky')} as const
  const buildMs = performance.now() - started
  const source = new Float32Array(prepared.built.initialSource)
  writePattern(source, prepared.built, compiled)
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

function runInOwnProcess<Result>(args: string[]): Result {
  const result = Bun.spawnSync(['bun', import.meta.path, ...args], {stdout: 'pipe', stderr: 'inherit'})
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} exited with ${result.exitCode}`)
  const lines = result.stdout.toString().trim().split('\n')
  return JSON.parse(lines.at(-1)!) as Result
}

const format = (value: number, digits = 0) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})

function all() {
  const variants: {form: Form, states: number, textLength: number}[] = [
    ...[8, 16, 32].flatMap(states => [256, 1024].map(textLength => ({form: 'data' as const, states, textLength}))),
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
  console.log('| Form | S | N | Cells | Live operations | Layers | Stored weights | Index reads | Build ms | Compile ms | RSS MB |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  console.log(sizeRows.join('\n'))
  console.log('\n| Form | S | N | µs per evaluation, program alone | µs through createEvaluator | µs per 1,000 live operations |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  console.log(timeRows.join('\n'))
}

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2)
  // Form (b), i.e. the forms `builtin` and `builtin-expensive` and the command `recompile`, was removed on October 14,
  // 2026. A command that still names one stops here instead of measuring another form.
  const isForm = (name: string | undefined): name is Form => name !== undefined && Object.hasOwn(formNames, name)
  if (command === undefined) {
    all()
  } else if (command !== 'sizes' && command !== 'time') {
    throw new Error(`unknown command ${command}`)
  } else if (!isForm(first)) {
    throw new Error(`unknown form ${first}: the forms are ${Object.keys(formNames).join(', ')}`)
  } else if (command === 'sizes') {
    console.log(JSON.stringify(sizes(first, Number(second), Number(third))))
  } else {
    console.log(JSON.stringify(time(first, Number(second), Number(third), fourth === 'raw' ? 'raw' : 'full')))
  }
}
