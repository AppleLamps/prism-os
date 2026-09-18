// Sizes and timings in Bun of the JSON highlighter's program, src/json-highlighter, in its three forms.
//   bun scripts/measure-json-highlighter.ts              every measurement, with each timing in its own process
//   bun scripts/measure-json-highlighter.ts sizes        source cells, live operations, layers, stored weights, per form and stage
//   bun scripts/measure-json-highlighter.ts time loop    µs per evaluation of one form, in this process
import {type Wire, invariant} from '../src/runtime/numeric-ui-core.ts'
import {createEvaluator} from '../src/runtime/cells.ts'
import {type ScanForm, buildHighlighter, scanForms, writeText} from '../src/json-highlighter/highlighter.ts'
import {capacity} from '../src/json-highlighter/kinds.ts'
import {timingText} from '../tests/json-highlighter/corpus.ts'
import {highlightReference} from '../tests/json-highlighter/reference.ts'

function sizeOf(built: ReturnType<typeof buildHighlighter>, roots: readonly Wire[]) {
  const program = built.circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let indexReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    indexReads += layer.indexReads.length
  }
  return {operations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights, indexReads}
}

const format = (size: ReturnType<typeof sizeOf>) =>
  `${size.operations} operations (${size.indexReads} index reads), ${size.layers} layers, ${size.storedWeights} stored weights`

function sizes() {
  for (const form of scanForms) {
    const start = performance.now()
    const built = buildHighlighter(form)
    const buildMs = performance.now() - start
    const {output} = built
    const withoutMatching = [...output.displayKinds, output.firstErrorPosition, output.firstErrorKind, output.valid, output.truncated, output.depthExceeded]
    const all = [...withoutMatching, output.caretBracket, output.matchingBracket]
    console.log(`${form}: ${built.circuit.sourceSize} source cells (${capacity + 2} written per keystroke), built in ${buildMs.toFixed(0)} ms`)
    console.log(`  every output: ${format(sizeOf(built, all))}`)
    console.log(`  without the matching bracket: ${format(sizeOf(built, withoutMatching))}`)
    console.log(`  the matching bracket alone, with the stages it reads: ${format(sizeOf(built, [output.caretBracket, output.matchingBracket]))}`)
    console.log(`  the tokenizer alone, up to every position's event: ${format(sizeOf(built, built.stages.events))}`)
    console.log(`  up to the grammar's state after every position: ${format(sizeOf(built, built.stages.grammarAfter))}`)
  }
}

// Median and largest µs per evaluation over batches, after a warm-up.
function timeBatches(run: (iteration: number) => void, batches = 30, perBatch = 50) {
  for (let iteration = 0; iteration < 200; iteration++) run(iteration)
  const perEvaluation: number[] = []
  let iteration = 0
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now()
    for (let index = 0; index < perBatch; index++) run(iteration++)
    perEvaluation.push((performance.now() - start) * 1000 / perBatch)
  }
  perEvaluation.sort((left, right) => left - right)
  return {median: perEvaluation[Math.floor(batches / 2)]!, largest: perEvaluation.at(-1)!}
}

function time(form: ScanForm) {
  const built = buildHighlighter(form)
  const {output} = built
  const roots = [...output.displayKinds, output.firstErrorPosition, output.firstErrorKind, output.valid, output.truncated, output.depthExceeded, output.caretBracket, output.matchingBracket]
  const evaluateCompiled = built.circuit.createTensorEvaluator(roots)
  const evaluateChecked = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  const text = timingText()
  // Iterations alternate between two valid texts that differ in one digit, like a keystroke that changes a number.
  const texts = [text, text.replace('12', '13')]
  const format = ({median, largest}: {median: number, largest: number}) => `median ${median.toFixed(0)} µs, largest batch ${largest.toFixed(0)} µs`
  const writeOnly = timeBatches(iteration => writeText(built.cells, source, texts[iteration % 2]!, 100))
  const compiled = timeBatches(iteration => {
    writeText(built.cells, source, texts[iteration % 2]!, 100)
    evaluateCompiled(source)
  })
  const checked = timeBatches(iteration => {
    writeText(built.cells, source, texts[iteration % 2]!, 100)
    evaluateChecked(source)
  })
  writeText(built.cells, source, '', 0)
  const empty = timeBatches(() => evaluateCompiled(source))
  console.log(`${form}: write ${format(writeOnly)}; write and evaluate ${format(compiled)}; with createEvaluator's checks ${format(checked)}; an empty text, evaluate only, ${format(empty)}`)
  const reference = timeBatches(iteration => highlightReference(texts[iteration % 2]!, 100))
  const parse = timeBatches(iteration => {
    JSON.parse(texts[iteration % 2]!)
  })
  console.log(`  in the same process, the plain JavaScript reference ${format(reference)}, JSON.parse ${format(parse)}`)
}

const [command, argument] = process.argv.slice(2)
if (command === 'sizes') {
  sizes()
} else if (command === 'time') {
  invariant(scanForms.includes(argument as ScanForm), `time takes one of ${scanForms.join(', ')}`)
  time(argument as ScanForm)
} else {
  sizes()
  for (const form of scanForms) {
    const result = Bun.spawnSync(['bun', import.meta.path, 'time', form], {stdout: 'pipe', stderr: 'inherit'})
    process.stdout.write(result.stdout.toString())
  }
}
