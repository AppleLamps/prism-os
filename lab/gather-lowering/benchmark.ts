import {validateOneHotGroups, validateTensorProgram} from '../../numeric-ui-core.ts'
import {buildLibraryCircuit, fillLibrarySource} from './library-circuit.ts'
import {
  createRandom,
  gatherStatistics,
  interleavedMedianNanoseconds,
  randomInteger,
  sameNumericValue,
} from './measure.ts'

// The benchmark from the brief: a photo library of slotCount items where the
// selected item's fields are read through one-hot indexing. Reported per
// configuration: stored sparse weights, tensor program size, and median
// execution time, with lowering off versus on. Run with:
//   bun lab/gather-lowering/benchmark.ts
//
// Every (configuration, mode) pair runs in its own subprocess: programs of
// different sizes and modes compile to different index-array widths (Uint8,
// Uint16, Uint32), and running two shapes through the shared executor in one
// process drives its hottest loops polymorphic, distorting timings by up to
// 10x — enough to invert the off/on comparison. One process per program keeps
// every access site monomorphic, the way a production circuit runs. Within a
// subprocess, the evaluation and the validation checks run round-robin in one
// loop so drift cannot bias the subtraction.
//
// Each configuration is measured across several subprocesses, and the report
// carries the min and max of the per-subprocess medians, not just their
// median: some cells are bimodal across subprocesses (the same code lands in
// one of two JIT states from run to run), and hiding that behind one number
// would overstate the timing precision. Stored-weight and program-size
// columns are exact and stable.

const slotCounts = [64, 256, 1024, 4096]
const readCounts = [1, 4, 16]
const timedRuns = 500
const warmupRuns = 100
const processRepeats = 5

type ModeMeasurement = {
  weights: number
  bytes: number
  evalNs: number
  rangeValidationNs: number
  oneHotValidationNs: number
}

// Per-subprocess median execution times (evaluation minus source-range
// validation), kept as the full sample so the reporter can show the spread.
type ModeSummary = {
  weights: number
  bytes: number
  executionNs: number[]
  oneHotValidationNs: number
}

type Row = {
  slotCount: number
  readCount: number
  off: ModeSummary
  on: ModeSummary
}

function programBytes(statistics: ReturnType<typeof gatherStatistics>) {
  return statistics.weightBytes
    + statistics.biasBytes
    + statistics.bookkeepingBytes
    + statistics.gatherBytes
}

function measureMode(slotCount: number, readCount: number, lower: boolean): ModeMeasurement {
  const {circuit, reads, valueWire} = buildLibraryCircuit(slotCount, readCount)
  const program = circuit.compileTensorProgram(reads, lower)
  validateTensorProgram(circuit, program)
  circuit.tensorProgram = program
  const statistics = gatherStatistics(program)

  // Ground the timing in exactness first: the program must match the
  // reference on every read, for a sample of selected slots.
  const source = new Float32Array(circuit.sourceSize)
  const random = createRandom(slotCount * 31 + readCount)
  for (let trial = 0; trial < 8; trial++) {
    const selectedSlot = randomInteger(random, slotCount)
    fillLibrarySource(source, slotCount, readCount, selectedSlot)
    const reference = circuit.evaluateReference(source)
    validateOneHotGroups(circuit, reference)
    const tensor = circuit.evaluateTensor(source)
    for (let field = 0; field < readCount; field++) {
      const read = reads[field]!
      const expected = source[valueWire(field, selectedSlot)]!
      if (!sameNumericValue(tensor[read]!, reference[read]!)
          || !sameNumericValue(reference[read]!, expected)) {
        throw new Error(
          `N=${slotCount} T=${readCount} slot ${selectedSlot} field ${field}: `
            + `tensor ${tensor[read]} reference ${reference[read]} expected ${expected}`,
        )
      }
    }
  }

  // Timing: rotate the selected slot between runs so no branch or cache
  // settles into an unrealistically fixed pattern. evaluateTensor validates
  // every source cell against its declared range on every call; that
  // pre-existing cost is O(sources) and mode-independent, so measuring it
  // alongside lets program execution be separated. The one-hot contract check
  // is timed as a would-be per-evaluation runtime check.
  fillLibrarySource(source, slotCount, readCount, 0)
  let rotatingSlot = 0
  const referenceValues = circuit.evaluateReference(source)
  const [evalNs, rangeValidationNs, oneHotValidationNs] = interleavedMedianNanoseconds([
    () => {
      source[rotatingSlot] = 0
      rotatingSlot = (rotatingSlot + 1) % slotCount
      source[rotatingSlot] = 1
      circuit.evaluateTensor(source)
    },
    () => circuit.validateSourceRanges(source),
    () => validateOneHotGroups(circuit, referenceValues),
  ], timedRuns, warmupRuns)

  return {
    weights: statistics.storedWeightCount,
    bytes: programBytes(statistics),
    evalNs: evalNs!,
    rangeValidationNs: rangeValidationNs!,
    oneHotValidationNs: oneHotValidationNs!,
  }
}

// Subprocess mode: measure one (configuration, mode) pair, printed as JSON.
if (process.argv.length === 5) {
  const measurement = measureMode(
    Number(process.argv[2]),
    Number(process.argv[3]),
    process.argv[4] === 'on',
  )
  console.log(JSON.stringify(measurement))
  process.exit(0)
}

function spawnMeasurement(slotCount: number, readCount: number, mode: 'off' | 'on') {
  const child = Bun.spawnSync({
    cmd: ['bun', import.meta.path, String(slotCount), String(readCount), mode],
    stdout: 'pipe',
    stderr: 'inherit',
  })
  if (!child.success) {
    throw new Error(`configuration N=${slotCount} T=${readCount} ${mode} failed`)
  }
  return JSON.parse(child.stdout.toString()) as ModeMeasurement
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!

function summarize(measurements: ModeMeasurement[]): ModeSummary {
  // Execution is the end-to-end median minus the source range validation
  // measured in the same subprocess, which both modes pay identically.
  return {
    weights: measurements[0]!.weights,
    bytes: measurements[0]!.bytes,
    executionNs: measurements.map(m => m.evalNs - m.rangeValidationNs),
    oneHotValidationNs: median(measurements.map(m => m.oneHotValidationNs)),
  }
}

const rows: Row[] = []
for (const slotCount of slotCounts) {
  for (const readCount of readCounts) {
    const offRuns: ModeMeasurement[] = []
    const onRuns: ModeMeasurement[] = []
    for (let repeat = 0; repeat < processRepeats; repeat++) {
      offRuns.push(spawnMeasurement(slotCount, readCount, 'off'))
      onRuns.push(spawnMeasurement(slotCount, readCount, 'on'))
    }
    rows.push({
      slotCount,
      readCount,
      off: summarize(offRuns),
      on: summarize(onRuns),
    })
    console.error(`measured N=${slotCount} T=${readCount}`)
  }
}

const microseconds = (nanoseconds: number) => (nanoseconds / 1_000).toFixed(1)
const range = (samples: number[]) =>
  `${microseconds(Math.min(...samples))}-${microseconds(Math.max(...samples))}`
const kilobytes = (bytes: number) => (bytes / 1_000).toFixed(1)
console.log('')
console.log(
  `${processRepeats} subprocesses per (configuration, mode), ${timedRuns} timed runs each;`
    + ' execution columns show the min-max of the per-subprocess medians.',
)
console.log('| N | T | stored weights off | on | program KB off | on | execution µs off | execution µs on | median speedup | one-hot check µs |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows) {
  const medianSpeedup = median(row.off.executionNs) / median(row.on.executionNs)
  console.log(
    `| ${row.slotCount} | ${row.readCount} | ${row.off.weights.toLocaleString('en-US')} `
      + `| ${row.on.weights} | ${kilobytes(row.off.bytes)} | ${kilobytes(row.on.bytes)} `
      + `| ${range(row.off.executionNs)} | ${range(row.on.executionNs)} `
      + `| ${medianSpeedup.toFixed(1)}x `
      + `| ${microseconds(row.on.oneHotValidationNs)} |`,
  )
}
