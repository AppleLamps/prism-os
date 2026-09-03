import {validateTensorProgram} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from '../../candidate-gallery.ts'
import {
  createWindowManagerMachine,
  sourceField as windowSourceField,
} from '../../window-manager.ts'
import {gatherStatistics, interleavedMedianNanoseconds} from './measure.ts'

// Execution-time impact of gather lowering on the production circuits, with
// the same methodology as benchmark.ts: every (circuit, mode) pair in its own
// subprocess so program shapes cannot pollute each other's JIT state, the
// evaluation interleaved with the source-range validation it always pays so
// execution can be separated, several subprocesses per pair, and the min-max
// of per-subprocess medians reported alongside the median. Run with:
//   bun lab/gather-lowering/production-benchmark.ts

const timedRuns = 500
const warmupRuns = 100
const processRepeats = 5

type Measurement = {
  weights: number
  gatherReads: number
  evalNs: number
  rangeValidationNs: number
}

function measure(circuitName: string, lower: boolean): Measurement {
  // Reach a realistic settled state through the machine's own stepping, then
  // time evaluations of that state. A pointer coordinate rotates between runs
  // so no branch settles into an unrealistically fixed pattern; those cells
  // carry a generous or open range, so the rotation never trips validation.
  let circuit
  let source: Float32Array
  let programRoots: number[]
  let rotatingCell: number
  if (circuitName === 'candidate') {
    const machine = createCandidateGalleryMachine()
    machine.step(1280, 800)
    machine.click(400, 300)
    machine.step(1280, 800)
    machine.source[0] = 1280 // viewportWidth
    machine.source[1] = 800 // viewportHeight
    circuit = machine.circuit
    source = machine.source
    programRoots = [...machine.tensorProgram.roots]
    rotatingCell = 4 // clickX
  } else {
    const machine = createWindowManagerMachine()
    machine.step(1280, 800, 16)
    machine.pointerDown(300, 70)
    machine.step(1280, 800, 32)
    machine.pointerUp(340, 90)
    machine.step(1280, 800, 48)
    machine.source[windowSourceField.viewportWidth] = 1280
    machine.source[windowSourceField.viewportHeight] = 800
    machine.source[windowSourceField.frameTime] = 64
    circuit = machine.circuit
    source = machine.source
    programRoots = [...machine.tensorProgram.roots]
    rotatingCell = windowSourceField.pointerX
  }
  const program = circuit.compileTensorProgram(programRoots, lower)
  validateTensorProgram(circuit, program)
  const statistics = gatherStatistics(program)
  circuit.tensorProgram = program
  circuit.evaluateTensor(source)

  let rotation = 0
  const [evalNs, rangeValidationNs] = interleavedMedianNanoseconds([
    () => {
      rotation = (rotation + 7) % 640
      source[rotatingCell] = 300 + rotation
      circuit.evaluateTensor(source)
    },
    () => circuit.validateSourceRanges(source),
  ], timedRuns, warmupRuns)

  return {
    weights: statistics.storedWeightCount,
    gatherReads: statistics.readCount,
    evalNs: evalNs!,
    rangeValidationNs: rangeValidationNs!,
  }
}

// Subprocess mode: one (circuit, mode) pair, printed as JSON.
if (process.argv.length === 4) {
  console.log(JSON.stringify(measure(process.argv[2]!, process.argv[3] === 'on')))
  process.exit(0)
}

function spawnMeasurement(circuitName: string, mode: 'off' | 'on') {
  const child = Bun.spawnSync({
    cmd: ['bun', import.meta.path, circuitName, mode],
    stdout: 'pipe',
    stderr: 'inherit',
  })
  if (!child.success) throw new Error(`${circuitName} ${mode} failed`)
  return JSON.parse(child.stdout.toString()) as Measurement
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!
const microseconds = (nanoseconds: number) => (nanoseconds / 1_000).toFixed(1)
const spread = (samples: number[]) =>
  `${microseconds(Math.min(...samples))}-${microseconds(Math.max(...samples))}`

console.log(
  `${processRepeats} subprocesses per (circuit, mode), ${timedRuns} timed runs each;`
    + ' execution = evaluation minus source-range validation, min-max of subprocess medians.',
)
console.log('| circuit | gather reads | stored weights off | on | execution µs off | on | median speedup |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const circuitName of ['candidate', 'window-manager']) {
  const argument = circuitName === 'candidate' ? 'candidate' : 'wm'
  const offRuns: Measurement[] = []
  const onRuns: Measurement[] = []
  for (let repeat = 0; repeat < processRepeats; repeat++) {
    offRuns.push(spawnMeasurement(argument, 'off'))
    onRuns.push(spawnMeasurement(argument, 'on'))
  }
  const executionOff = offRuns.map(run => run.evalNs - run.rangeValidationNs)
  const executionOn = onRuns.map(run => run.evalNs - run.rangeValidationNs)
  console.log(
    `| ${circuitName} | ${onRuns[0]!.gatherReads} `
      + `| ${offRuns[0]!.weights.toLocaleString('en-US')} | ${onRuns[0]!.weights.toLocaleString('en-US')} `
      + `| ${spread(executionOff)} | ${spread(executionOn)} `
      + `| ${(median(executionOff) / median(executionOn)).toFixed(2)}x |`,
  )
  console.error(`measured ${circuitName}`)
}
