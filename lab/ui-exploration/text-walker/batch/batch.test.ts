// The batch line breaking programs against pretext's layout(): line counts for short and long generated paragraphs at
// many widths, codegen's instance backends, the reference evaluator's contracts, the overflow outputs, edge paragraphs,
// and the exported program's round trip.
import {expect, test} from 'bun:test'
import {validateIndexReads, validateOneHotGroups} from '../../../../src/runtime/numeric-ui-core.ts'
import {deserializeTensorProgram, serializeTensorProgram} from './export.ts'
import {createBatchInstanceRunner} from './instances.ts'
import {type BatchCapacity, type BatchParagraph, assertFits, batchCapacities, batchParagraphs, expectedLineCount, paragraphNeeds, prepareBatchParagraph} from './paragraphs.ts'
import {type BatchProgram, type Formulation, allFormulations, buildBatchProgram, decodeOutputs, instanceCellCount, paragraphSourceTable, writeInstanceCells} from './programs.ts'

// 160 to 480 px in 16 px steps, each also 1/8 and 1/4 px wider, so some spans equal the width exactly.
const testWidths: number[] = []
for (let width = 160; width <= 480; width += 16) {
  for (const offset of [0, 0.125, 0.25]) if (width + offset <= 480) testWidths.push(width + offset)
}

function executorMismatches(program: BatchProgram, paragraphs: readonly BatchParagraph[], widths: readonly number[]) {
  const problems: unknown[] = []
  const table = new Float32Array(program.fc.circuit.sourceSize)
  paragraphs.forEach((paragraph, index) => {
    for (const width of widths) {
      const outputs = decodeOutputs(program, program.compiled.evaluate(paragraphSourceTable(program, paragraph, width, table)))
      const expected = {lineCount: expectedLineCount(paragraph, width), moreLinesThanSlots: 0, windowOverflow: 0, runOverflow: 0}
      if (JSON.stringify(outputs) !== JSON.stringify(expected)) problems.push({formulation: program.formulation, paragraph: index, width, outputs, expected})
    }
  })
  return problems.slice(0, 5)
}

test('every formulation gives pretext\'s line count for short paragraphs at every tested width', () => {
  const capacity = batchCapacities.short
  const paragraphs = batchParagraphs('short', 32)
  for (const paragraph of paragraphs) assertFits(capacity, paragraph)
  // The set has hyphenated words and runs of up to 3 break-after segments, so skip(j) is exercised.
  expect(Math.max(...paragraphs.map(paragraph => paragraphNeeds(paragraph, 160, 480).runLimit))).toBe(3)
  for (const formulation of allFormulations) {
    expect(executorMismatches(buildBatchProgram(formulation, capacity), paragraphs, testWidths)).toEqual([])
  }
}, 30_000)

test('the index-read and segment-walker formulations give pretext\'s line count for long paragraphs', () => {
  const capacity = batchCapacities.long
  const paragraphs = batchParagraphs('long', 4)
  for (const paragraph of paragraphs) assertFits(capacity, paragraph)
  for (const formulation of ['index-read', 'segment-walker'] as const) {
    expect(executorMismatches(buildBatchProgram(formulation, capacity), paragraphs, testWidths)).toEqual([])
  }
}, 30_000)

test('codegen\'s generated JavaScript and batched executor run the one-hot and segment-walker programs over many paragraphs, each at its own width', () => {
  const capacity = batchCapacities.short
  const paragraphs = batchParagraphs('short', 96, 1000)
  const columns = instanceCellCount(capacity)
  const cells = new Float32Array(paragraphs.length * columns)
  const widths = paragraphs.map((_, index) => testWidths[(index * 7) % testWidths.length]!)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(cells, index * columns, capacity, paragraph, widths[index]!))
  const expected = paragraphs.map((paragraph, index) => expectedLineCount(paragraph, widths[index]!))
  for (const formulation of ['one-hot', 'segment-walker'] as const) {
    const program = buildBatchProgram(formulation, capacity)
    for (const backend of ['generated', 'batched'] as const) {
      const runner = createBatchInstanceRunner(program, backend)
      const outputs = new Float32Array(paragraphs.length * program.outputNames.length)
      runner.run(cells, paragraphs.length, outputs)
      const decoded = paragraphs.map((_, index) => decodeOutputs(program, outputs, index * program.outputNames.length))
      expect(decoded.map(output => output.lineCount)).toEqual(expected)
      expect(decoded.filter(output => output.moreLinesThanSlots + output.windowOverflow + output.runOverflow !== 0)).toEqual([])
    }
  }
  expect(() => createBatchInstanceRunner(buildBatchProgram('index-read', capacity), 'generated')).toThrow('index reads')
}, 30_000)

test('the reference evaluator holds the declared one-hot groups and integer indexes, and agrees with the executor', () => {
  const cases: [Formulation, BatchCapacity, BatchParagraph[]][] = [
    ['one-hot', batchCapacities.short, batchParagraphs('short', 3, 2000)],
    ['index-read', batchCapacities.short, batchParagraphs('short', 3, 2000)],
    ['index-read', batchCapacities.long, batchParagraphs('long', 2, 2000)],
  ]
  for (const [formulation, capacity, paragraphs] of cases) {
    const program = buildBatchProgram(formulation, capacity)
    const circuit = program.fc.circuit
    for (const paragraph of paragraphs) {
      for (const width of [160, 320.125, 480]) {
        const source = paragraphSourceTable(program, paragraph, width)
        const values = circuit.evaluateReference(source)
        validateOneHotGroups(circuit, values)
        validateIndexReads(circuit, values)
        const executorLineCount = program.compiled.evaluate(source)[0]
        expect([values[program.compiled.roots[0]!], executorLineCount]).toEqual([expectedLineCount(paragraph, width), expectedLineCount(paragraph, width)])
      }
    }
  }
}, 30_000)

test('too few line slots, too small a window and runs longer than the run limit are reported', () => {
  const paragraphs = batchParagraphs('short', 64, 3000)
  const withRun = paragraphs.find(paragraph => paragraphNeeds(paragraph, 160, 480).runLimit === 3)!
  expect(withRun).toBeDefined()
  const paragraph = paragraphs[0]!
  const linesAt160 = expectedLineCount(paragraph, 160)
  expect(linesAt160).toBeGreaterThan(2)
  const base = batchCapacities.short
  for (const formulation of ['one-hot', 'index-read'] as const) {
    const fewSlots = buildBatchProgram(formulation, {...base, lineSlots: linesAt160 - 1})
    expect(decodeOutputs(fewSlots, fewSlots.compiled.evaluate(paragraphSourceTable(fewSlots, paragraph, 160)))).toEqual({lineCount: linesAt160 - 1, moreLinesThanSlots: 1, windowOverflow: 0, runOverflow: 0})
    // With lines of about 20 segments at 480 px, a window of 6 segments is too small.
    const smallWindow = buildBatchProgram(formulation, {...base, window: 6})
    expect(decodeOutputs(smallWindow, smallWindow.compiled.evaluate(paragraphSourceTable(smallWindow, paragraph, 480))).windowOverflow).toBeGreaterThan(0)
    const shortRuns = buildBatchProgram(formulation, {...base, runLimit: 1})
    expect(decodeOutputs(shortRuns, shortRuns.compiled.evaluate(paragraphSourceTable(shortRuns, withRun, 320))).runOverflow).toBeGreaterThan(0)
  }
}, 30_000)

test('a one-segment paragraph, and a paragraph that fills every segment cell', () => {
  const single = prepareBatchParagraph('hello')
  const full = batchParagraphs('short', 1, 4000)[0]!
  const fullCapacity = {...batchCapacities.short, segments: full.paragraph.widths.length}
  for (const formulation of allFormulations) {
    expect(executorMismatches(buildBatchProgram(formulation, batchCapacities.short), [single], [160, 480])).toEqual([])
    expect(executorMismatches(buildBatchProgram(formulation, fullCapacity), [full], [160, 240.25, 480])).toEqual([])
  }
}, 30_000)

test('the exported program survives JSON with its shared tables', () => {
  const program = buildBatchProgram('index-read', batchCapacities.short)
  const tensorProgram = program.compiled.circuit.tensorProgram!
  const serialized = JSON.parse(JSON.stringify(serializeTensorProgram(tensorProgram)))
  const restored = deserializeTensorProgram(serialized)
  expect(restored).toEqual(tensorProgram)
  const reads = restored.layers.flatMap(layer => layer.indexReads)
  expect(new Set(reads.map(read => read.candidatePositions)).size).toBe(new Set(tensorProgram.layers.flatMap(layer => layer.indexReads).map(read => read.candidatePositions)).size)
})
