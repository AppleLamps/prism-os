// Prints what the README says about sizes and documents, without a GPU:
//   bun lab/json-search/report.ts sizes                 both programs and their shaders, with and without guards
//   bun lab/json-search/report.ts documents [count]     the generated documents' shapes, defects and lengths, 100,000 by default
//   bun lab/json-search/report.ts examples [count]      the first documents' texts, 8 by default
//   bun lab/json-search/report.ts loops                 the loop programs' stages and their shaders
import {describeDocuments, generateDocuments} from './documents.ts'
import {buildJsonLoop} from './json-step.ts'
import {emitLoopWgsl} from './loop-emit.ts'
import {type LoopProgram, describeLoop, operationsPerDocument} from './loop-program.ts'
import {buildBatchPrograms, cellsPerDocument} from './program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from './search-step.ts'

const [command = 'sizes', countText] = process.argv.slice(2)
const format = (value: number) => value.toLocaleString('en-US')

if (command === 'sizes') {
  const {programs, buildMs} = buildBatchPrograms()
  console.log(`buildHighlighter('loop'): ${Math.round(buildMs)} ms`)
  console.log('| Outputs | Guard | Live operations | Layers | Index reads | WGSL statements | WGSL bytes | Guards | Literals of 2^24 or more | Generated JavaScript bytes |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const program of programs) {
    const generated = program.emitJavaScript()
    for (const guard of ['none', 'max'] as const) {
      const shader = program.emitShader({guard})
      console.log(`| ${program.rootSet} | ${guard} | ${format(program.sizes.operations)} | ${format(program.sizes.layers)} | ${format(program.sizes.indexReads)} | ${format(shader.statementCount)} | ${format(shader.bytes)} | ${format(shader.guards)} | ${shader.largeIntegerLiterals} | ${format(generated.sourceBytes)} |`)
    }
  }
} else if (command === 'documents') {
  const description = describeDocuments(generateDocuments(Number(countText ?? 100_000)))
  console.log(JSON.stringify(description, null, 1))
} else if (command === 'examples') {
  for (const document of generateDocuments(Number(countText ?? 8))) console.log(`${document.shape}, ${document.defect}:\n${document.text}\n`)
} else if (command === 'loops') {
  console.log('| Loop program | Positions | Operations per stage | Table reads per stage | Operations per document | Shared cells | WGSL statements | WGSL bytes |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  const row = (name: string, loop: LoopProgram) => {
    const stages = describeLoop(loop)
    const shader = emitLoopWgsl(loop)
    console.log(`| ${name} | ${loop.positions} | ${stages.map(stage => `${stage.name} ${format(stage.operations)}`).join(', ')} | ${stages.map(stage => format(stage.indexReads)).join(', ')} | ${format(operationsPerDocument(loop))} | ${format(loop.sharedValues.length)} | ${format(shader.statementCount)} | ${format(shader.bytes)} |`)
  }
  row('JSON highlighter', buildJsonLoop().loop)
  for (const masked of [false, true]) {
    for (const states of [8, 16, 32]) {
      for (const positions of masked ? [512] : [256, 512]) {
        row(`regex search, ${states} states${masked ? ', reading display kinds' : ''}`, buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument, masked, stopAtLength: false}).loop)
      }
    }
  }
} else {
  throw new Error(`unknown command ${command}`)
}
