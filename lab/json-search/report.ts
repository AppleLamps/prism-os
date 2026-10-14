// Prints what the README says about sizes and documents, without a GPU:
//   bun lab/json-search/report.ts sizes                 both programs and their shaders, with and without guards
//   bun lab/json-search/report.ts documents [count]     the generated documents' shapes, defects and lengths, 100,000 by default
//   bun lab/json-search/report.ts examples [count]      the first documents' texts, 8 by default
//   bun lab/json-search/report.ts loops                 the loop programs' stages and their shaders
//   bun lab/json-search/report.ts edge-cases            the searcher on the CPU against the programs with every position
//                                                       written out, on the executor, over documents and patterns at the
//                                                       limits, about 5 minutes
import {createCorpus} from '../../tests/json-search/highlighter/corpus.ts'
import {describeDocuments, generateDocuments} from '../../src/json-search/documents.ts'
import {type Comparison, compareWithWrittenOutPrograms, edgeDocuments, edgeSearches} from '../../tests/json-search/edge-cases.ts'
import {buildJsonLoop} from '../../src/json-search/json-step.ts'
import {emitLoopWgsl} from '../../src/json-search/loop-emit.ts'
import {type LoopProgram, describeLoop, operationsPerDocument} from '../../src/json-search/loop-program.ts'
import {buildBatchPrograms, cellsPerDocument} from '../../src/json-search/program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from '../../src/json-search/search-step.ts'
import {createCpuSearcher} from '../../src/json-search/searcher.ts'

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
} else if (command === 'edge-cases') {
  const print = (name: string, comparison: Comparison) => console.log(`${name}: ${format(comparison.documents)} documents, of which the executor calls ${format(comparison.expectedValidDocuments)} valid. Validation and kinds: ${format(comparison.validationValues)} values, ${comparison.validationMismatches} different. ${comparison.searches} searches, of which ${comparison.searchesWithMatches} find something, ${format(comparison.expectedMatches)} matches and ${format(comparison.expectedMarkedPositions)} marked positions in all: ${format(comparison.searchValues)} values, ${comparison.searchMismatches} different. The executor took ${format(Math.round(comparison.executorMs))} ms.${comparison.examples.length === 0 ? '' : `\n  ${comparison.examples.join('\n  ')}`}`)
  // The sizes of gpu/review-run.ts's edge mode, so both compare the same documents.
  const documents = edgeDocuments({broken: 400, generated: 200, random: 100, mutated: 300, long: 40})
  const texts = documents.map(document => document.text)
  print('Up to 16 states, generated JavaScript', await compareWithWrittenOutPrograms(createCpuSearcher(texts, {windowCapacity: texts.length}), texts, [...edgeSearches(8), ...edgeSearches(16)], {windowDocuments: texts.length, maxWrittenOutStates: 16}))
  // The program of 32 states with every position written out is 1,167,392 operations and takes about 13 ms per
  // document, so it runs over the hand-written documents of more than one code point.
  const longer = documents.filter(document => document.name.startsWith('one code point') === false && document.name.includes('generated') === false && document.name.includes('highlighter test text') === false).map(document => document.text)
  print('32 states, generated JavaScript', await compareWithWrittenOutPrograms(createCpuSearcher(longer, {windowCapacity: longer.length}), longer, edgeSearches(32), {windowDocuments: longer.length, maxWrittenOutStates: 32}))
  // The loop programs on the CPU executor, over every fourth of those documents, a window of 16 at a time.
  const sample = longer.filter((_, index) => index % 4 === 0)
  print('Up to 16 states, the loop programs on the CPU executor', await compareWithWrittenOutPrograms(createCpuSearcher(sample, {windowCapacity: 16, backend: 'executor'}), sample, [...edgeSearches(8), ...edgeSearches(16)].filter((_, index) => index % 3 === 0), {windowDocuments: 16, maxWrittenOutStates: 16}))
  // The highlighter's loop alone, over many more texts of the highlighter's own kinds and broken generated documents.
  const many = [...createCorpus(20261015, {random: 6000, mutated: 18_000, long: 1500}).all, ...generateDocuments(6000, 979, 1).map(document => document.text)]
  print('The highlighter\'s loop alone, generated JavaScript', await compareWithWrittenOutPrograms(createCpuSearcher(many, {windowCapacity: 1}), many, [], {windowDocuments: 1, maxWrittenOutStates: 8}))
} else {
  throw new Error(`unknown command ${command}`)
}
