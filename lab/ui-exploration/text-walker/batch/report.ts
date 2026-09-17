// Measurements for the README's "Many paragraphs on the GPU" section.
//   bun lab/ui-exploration/text-walker/batch/report.ts sizes
//     program sizes, build and compile times, and codegen's instance plans, written to results/sizes.json
//   bun lab/ui-exploration/text-walker/batch/report.ts sweep [--count 1024] [--executor-count 64]
//     line counts against pretext's layout() for every paragraph at every sweep width, written to results/sweep.json:
//     generated JavaScript for the one-hot and segment-walker programs and the executor for the index-read program over
//     every paragraph, and the executor and the batched executor for the other two over the first --executor-count paragraphs
//   bun lab/ui-exploration/text-walker/batch/report.ts timings <file.jsonl>...
//     the median of cpu-time.ts's process medians per variant, their range, and the load averages
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {walkLineRanges} from '@chenglou/pretext'
import {type InstanceBackend, createBatchInstanceRunner} from './instances.ts'
import {type BatchParagraph, type ParagraphSize, assertFits, batchCapacities, batchParagraphs, expectedLineCount} from './paragraphs.ts'
import {type BatchProgram, allFormulations, buildBatchProgram, decodeOutputs, instanceCellCount, paragraphSourceTable, writeInstanceCells} from './programs.ts'

const resultsFolder = join(import.meta.dir, 'results')
const sizes: ParagraphSize[] = ['short', 'long']
const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const format = (value: number) => value.toLocaleString('en-US')
const printRow = (cells: (string | number)[]) => console.log(`| ${cells.map(cell => typeof cell === 'number' ? format(cell) : cell).join(' | ')} |`)
const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()

function writeResult(name: string, value: unknown) {
  if (!existsSync(resultsFolder)) mkdirSync(resultsFolder, {recursive: true})
  writeFileSync(join(resultsFolder, name), `${JSON.stringify(value, null, 2)}\n`)
}

// Every whole pixel from 160 to 480 px, and 64 widths on the 1/8 px grid from a seeded generator.
export function sweepWidths() {
  const widths: number[] = []
  for (let width = 160; width <= 480; width++) widths.push(width)
  let state = 12345
  for (let index = 0; index < 64; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    widths.push(160 + Math.floor((state / 2 ** 32) * 2560) / 8)
  }
  return widths
}

function reportSizes() {
  const rows: object[] = []
  printRow(['Size', 'Formulation', 'Segments', 'Line slots', 'Window', 'Live ops', 'Layers', 'Stored weights', 'Gather reads', 'Gather table entries', 'One-hot ops', 'Index reads', 'Stored index positions', 'Build ms', 'Compile ms', 'Instance rows', 'Instance layers'])
  printRow(Array(17).fill('---'))
  for (const size of sizes) {
    const capacity = batchCapacities[size]
    for (const formulation of allFormulations) {
      const program = buildBatchProgram(formulation, capacity)
      const size_ = program.compiled.size
      const plan = program.indexReads.reads === 0 ? createBatchInstanceRunner(program, 'batched').plan : null
      const row = {
        size, formulation, capacity, sizes: size_, indexReads: program.indexReads,
        buildMilliseconds: Math.round(program.buildMilliseconds), compileMilliseconds: Math.round(program.compileMilliseconds),
        instancePlan: plan?.counts ?? null, loadAverage: loadAverage(),
      }
      rows.push(row)
      printRow([
        size, formulation, capacity.segments, formulation === 'segment-walker' ? '-' : capacity.lineSlots, formulation === 'segment-walker' ? '-' : capacity.window,
        size_.liveOperations, size_.layers, size_.storedWeights, size_.gatherReads, size_.gatherTableEntries, size_.oneHotOperations,
        program.indexReads.reads, program.indexReads.storedPositions, row.buildMilliseconds, row.compileMilliseconds,
        plan === null ? '-' : plan.counts.instanceRows, plan === null ? '-' : plan.counts.instanceLayers,
      ])
    }
  }
  writeResult('sizes.json', rows)
}

type SweepRecord = {size: ParagraphSize, formulation: string, backend: string, paragraphs: number, widths: number, checks: number, mismatches: number, overflows: number, examples: unknown[], milliseconds: number}

function sweepExecutor(program: BatchProgram, paragraphs: readonly BatchParagraph[], widths: readonly number[], expected: Int32Array): SweepRecord {
  const started = performance.now()
  const table = new Float32Array(program.fc.circuit.sourceSize)
  let mismatches = 0
  let overflows = 0
  const examples: unknown[] = []
  paragraphs.forEach((paragraph, index) => {
    widths.forEach((width, widthIndex) => {
      const outputs = decodeOutputs(program, program.compiled.evaluate(paragraphSourceTable(program, paragraph, width, table)))
      const lines = expected[index * widths.length + widthIndex]!
      if (outputs.lineCount !== lines) {
        mismatches++
        if (examples.length < 5) examples.push({paragraph: index, width, outputs, lines})
      }
      if (outputs.moreLinesThanSlots + outputs.windowOverflow + outputs.runOverflow !== 0) overflows++
    })
  })
  return {size: program.capacity.size, formulation: program.formulation, backend: 'executor', paragraphs: paragraphs.length, widths: widths.length, checks: paragraphs.length * widths.length, mismatches, overflows, examples, milliseconds: Math.round(performance.now() - started)}
}

function sweepInstances(program: BatchProgram, backend: InstanceBackend, paragraphs: readonly BatchParagraph[], widths: readonly number[], expected: Int32Array): SweepRecord {
  const started = performance.now()
  const runner = createBatchInstanceRunner(program, backend)
  const capacity = program.capacity
  const columns = instanceCellCount(capacity)
  const cells = new Float32Array(paragraphs.length * columns)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(cells, index * columns, capacity, paragraph, widths[0]!))
  const outputCount = program.outputNames.length
  const outputs = new Float32Array(paragraphs.length * outputCount)
  let mismatches = 0
  let overflows = 0
  const examples: unknown[] = []
  widths.forEach((width, widthIndex) => {
    for (let index = 0; index < paragraphs.length; index++) cells[index * columns] = width
    runner.run(cells, paragraphs.length, outputs)
    for (let index = 0; index < paragraphs.length; index++) {
      const decoded = decodeOutputs(program, outputs, index * outputCount)
      const lines = expected[index * widths.length + widthIndex]!
      if (decoded.lineCount !== lines) {
        mismatches++
        if (examples.length < 5) examples.push({paragraph: index, width, outputs: decoded, lines})
      }
      if (decoded.moreLinesThanSlots + decoded.windowOverflow + decoded.runOverflow !== 0) overflows++
    }
  })
  return {size: capacity.size, formulation: program.formulation, backend, paragraphs: paragraphs.length, widths: widths.length, checks: paragraphs.length * widths.length, mismatches, overflows, examples, milliseconds: Math.round(performance.now() - started)}
}

function reportSweep() {
  const count = Number(argument('--count') ?? 1024)
  const executorCount = Number(argument('--executor-count') ?? 64)
  const widths = sweepWidths()
  const records: object[] = []
  for (const size of sizes) {
    const capacity = batchCapacities[size]
    const paragraphs = batchParagraphs(size, count)
    for (const paragraph of paragraphs) assertFits(capacity, paragraph)
    const expected = new Int32Array(count * widths.length)
    // How many lines start right after a run of 1, 2 or 3 break-after segments, so the sweep isn't vacuous for skip(j).
    const linesAfterRun: Record<number, number> = {}
    let lines = 0
    paragraphs.forEach((paragraph, index) => {
      const {breakAfter} = paragraph.paragraph
      widths.forEach((width, widthIndex) => {
        expected[index * widths.length + widthIndex] = expectedLineCount(paragraph, width)
        walkLineRanges(paragraph.prepared, width, line => {
          lines++
          let run = 0
          while (line.start.segmentIndex - run - 1 >= 0 && breakAfter[line.start.segmentIndex - run - 1] === 1) run++
          if (line.start.segmentIndex > 0) linesAfterRun[run] = (linesAfterRun[run] ?? 0) + 1
        })
      })
    })
    records.push({size, paragraphs: count, widths: widths.length, lines, linesAfterRun})
    console.log(JSON.stringify(records.at(-1)))
    for (const formulation of allFormulations) {
      const program = buildBatchProgram(formulation, capacity)
      const sweeps = formulation === 'index-read'
        ? [sweepExecutor(program, paragraphs, widths, expected)]
        : [
            sweepInstances(program, 'generated', paragraphs, widths, expected),
            sweepExecutor(program, paragraphs.slice(0, executorCount), widths, expected),
            sweepInstances(program, 'batched', paragraphs.slice(0, executorCount), widths, expected),
          ]
      for (const sweep of sweeps) {
        records.push({...sweep, loadAverage: loadAverage()})
        console.log(JSON.stringify(records.at(-1)))
      }
    }
  }
  writeResult('sweep.json', records)
}

type TimingRecord = {variant: string, size: string, count: number, width: number, microsecondsPerParagraph: number, loadBefore: string, loadAfter: string, failed?: boolean, killedFor?: string}

function reportTimings(files: readonly string[]) {
  const records = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TimingRecord))
  const groups = new Map<string, TimingRecord[]>()
  for (const record of records) {
    if (record.failed === true) {
      console.log(`failed: ${JSON.stringify(record).slice(0, 300)}`)
      continue
    }
    const key = `${record.size} ${record.variant} ${record.count} ${record.width}`
    groups.set(key, [...groups.get(key) ?? [], record])
  }
  const firstLoad = (load: string) => Number(load.replace(/[{}]/g, '').trim().split(/\s+/)[0])
  printRow(['Size', 'Variant', 'Paragraphs', 'Width', 'µs per paragraph, median of processes', 'Range', 'Processes', 'Load average'])
  printRow(Array(8).fill('---'))
  for (const [, group] of groups) {
    const values = group.map(record => record.microsecondsPerParagraph).sort((left, right) => left - right)
    const middle = values.length % 2 === 1 ? values[(values.length - 1) / 2]! : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2
    const loads = group.flatMap(record => [firstLoad(record.loadBefore), firstLoad(record.loadAfter)])
    const precise = (value: number) => value < 100 ? value.toPrecision(3) : format(Math.round(value))
    printRow([group[0]!.size, group[0]!.variant, group[0]!.count, group[0]!.width, precise(middle), `${precise(values[0]!)} to ${precise(values.at(-1)!)}`, group.length, `${Math.min(...loads)} to ${Math.max(...loads)}`])
  }
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'sizes') reportSizes()
  else if (command === 'sweep') reportSweep()
  else if (command === 'timings') reportTimings(process.argv.slice(3))
  else throw new Error('usage: report.ts sizes | sweep [--count 1024] [--executor-count 64] | timings <file.jsonl>...')
}
