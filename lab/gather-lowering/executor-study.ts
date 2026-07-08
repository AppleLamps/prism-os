import {validateTensorProgram} from '../../numeric-ui-core.ts'
import {buildLibraryCircuit, fillLibrarySource} from './library-circuit.ts'
import {
  type CompiledProgram,
  interleavedMedianNanoseconds,
  sameNumericValue,
} from './measure.ts'

// Reproducible measurements behind two README claims, kept as code so the
// numbers can be regenerated at any time. Run with:
//   bun lab/gather-lowering/executor-study.ts
//
// 1. Phase decomposition: how much of one evaluation the sparse matmul costs
//    in the dense program versus the gather work in the lowered program, on
//    the N=4096, T=1 library. Measured on a faithful local replica of the
//    executor with timers between phases; the replica's untimed end-to-end
//    median is reported next to the real executor's so the fidelity of the
//    replica is itself visible.
// 2. The JIT pathology that forced applyGathers out of evaluateTensorProgram:
//    a replica with the gather loops inlined in the evaluation function runs
//    far slower than the same code with the loops extracted, on identical
//    work, because JavaScriptCore's top tier fails to optimize the monolithic
//    function. Each variant runs in its own subprocess so the compiled
//    function shapes cannot pollute each other.

const slotCount = 4096
const readCount = 1
const timedRuns = 500
const warmupRuns = 200

// A faithful copy of the core executor with the gather loops in a separate
// function, mirroring the shipped structure.
function replicaExtracted(source: Float32Array, program: CompiledProgram): Float32Array {
  const {layers, valueCount, wireOrder, width} = program
  const packedValues = new Float32Array(valueCount)
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of layers) maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
  for (const layer of layers) maxInputSize = Math.max(maxInputSize, layer.inputSize)
  const input = new Float32Array(maxInputSize)
  const projection = new Float32Array(maxProjectionSize)
  const gatherIndices = new Int32Array(program.gatherSlotCount)
  const gatherMasses = new Float32Array(program.gatherSlotCount)
  packedValues.set(source)
  let availableValues = source.length
  for (const layer of layers) {
    const {outputSize} = layer
    for (let column = 0; column < layer.inputSize; column++) {
      input[column] = packedValues[layer.inputIndices[column]!]!
    }
    replicaMatmul(projection, layer, input)
    if (layer.gatherReads.length > 0) {
      replicaGathers(layer, packedValues, projection, gatherIndices, gatherMasses)
    }
    for (let gateRow = 0; gateRow < layer.gateRows.length; gateRow++) {
      const outputRow = layer.gateRows[gateRow]!
      projection[outputRow] = Math.fround(
        projection[outputRow]! * Math.max(0, projection[outputSize + gateRow]!),
      )
    }
    packedValues.set(projection.subarray(0, outputSize), availableValues)
    availableValues += outputSize
  }
  const values = new Float32Array(width)
  for (let packedIndex = 0; packedIndex < wireOrder.length; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  return values
}

// The same executor with the gather loops inlined into the function body —
// the structure that was measured to defeat the engine's top JIT tier.
function replicaMonolithic(source: Float32Array, program: CompiledProgram): Float32Array {
  const {layers, valueCount, wireOrder, width} = program
  const packedValues = new Float32Array(valueCount)
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of layers) maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
  for (const layer of layers) maxInputSize = Math.max(maxInputSize, layer.inputSize)
  const input = new Float32Array(maxInputSize)
  const projection = new Float32Array(maxProjectionSize)
  const gatherIndices = new Int32Array(program.gatherSlotCount)
  const gatherMasses = new Float32Array(program.gatherSlotCount)
  packedValues.set(source)
  let availableValues = source.length
  for (const layer of layers) {
    const {outputSize} = layer
    for (let column = 0; column < layer.inputSize; column++) {
      input[column] = packedValues[layer.inputIndices[column]!]!
    }
    replicaMatmul(projection, layer, input)
    for (const compute of layer.gatherComputes) {
      let index = 0
      let mass = 0
      for (let position = 0; position < compute.bitPositions.length; position++) {
        const bit = packedValues[compute.bitPositions[position]!]!
        index += position * bit
        mass += bit
      }
      gatherIndices[compute.slot] = index
      gatherMasses[compute.slot] = mass
    }
    for (const read of layer.gatherReads) {
      const limit = read.candidatePositions.length - 1
      const index = Math.min(Math.max(gatherIndices[read.slot]!, 0), limit)
      let contribution = packedValues[read.candidatePositions[index]!]!
      if (read.masked) contribution = Math.fround(gatherMasses[read.slot]! * contribution)
      projection[read.row] = Math.fround(projection[read.row]! + contribution)
    }
    for (let gateRow = 0; gateRow < layer.gateRows.length; gateRow++) {
      const outputRow = layer.gateRows[gateRow]!
      projection[outputRow] = Math.fround(
        projection[outputRow]! * Math.max(0, projection[outputSize + gateRow]!),
      )
    }
    packedValues.set(projection.subarray(0, outputSize), availableValues)
    availableValues += outputSize
  }
  const values = new Float32Array(width)
  for (let packedIndex = 0; packedIndex < wireOrder.length; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  return values
}

function replicaMatmul(
  projection: Float32Array,
  layer: CompiledProgram['layers'][number],
  input: Float32Array,
) {
  for (let row = 0; row < layer.bias.length; row++) {
    let value = layer.bias[row]!
    for (let index = layer.rowOffsets[row]!; index < layer.rowOffsets[row + 1]!; index++) {
      const product = Math.fround(layer.weights[index]! * input[layer.columns[index]!]!)
      value = Math.fround(value + product)
    }
    projection[row] = value
  }
}

function replicaGathers(
  layer: CompiledProgram['layers'][number],
  packedValues: Float32Array,
  projection: Float32Array,
  gatherIndices: Int32Array,
  gatherMasses: Float32Array,
) {
  for (const compute of layer.gatherComputes) {
    let index = 0
    let mass = 0
    for (let position = 0; position < compute.bitPositions.length; position++) {
      const bit = packedValues[compute.bitPositions[position]!]!
      index += position * bit
      mass += bit
    }
    gatherIndices[compute.slot] = index
    gatherMasses[compute.slot] = mass
  }
  for (const read of layer.gatherReads) {
    const limit = read.candidatePositions.length - 1
    const index = Math.min(Math.max(gatherIndices[read.slot]!, 0), limit)
    let contribution = packedValues[read.candidatePositions[index]!]!
    if (read.masked) contribution = Math.fround(gatherMasses[read.slot]! * contribution)
    projection[read.row] = Math.fround(projection[read.row]! + contribution)
  }
}

// The extracted replica with timers between phases, accumulating into `bag`.
function replicaPhased(
  source: Float32Array,
  program: CompiledProgram,
  bag: Record<string, number>,
): Float32Array {
  const {layers, valueCount, wireOrder, width} = program
  let stamp = Bun.nanoseconds()
  const takePhase = (name: string) => {
    const now = Bun.nanoseconds()
    bag[name] = (bag[name] ?? 0) + now - stamp
    stamp = now
  }
  const packedValues = new Float32Array(valueCount)
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of layers) maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
  for (const layer of layers) maxInputSize = Math.max(maxInputSize, layer.inputSize)
  const input = new Float32Array(maxInputSize)
  const projection = new Float32Array(maxProjectionSize)
  const gatherIndices = new Int32Array(program.gatherSlotCount)
  const gatherMasses = new Float32Array(program.gatherSlotCount)
  packedValues.set(source)
  takePhase('setup')
  let availableValues = source.length
  for (const layer of layers) {
    const {outputSize} = layer
    for (let column = 0; column < layer.inputSize; column++) {
      input[column] = packedValues[layer.inputIndices[column]!]!
    }
    takePhase('inputStaging')
    replicaMatmul(projection, layer, input)
    takePhase('matmul')
    if (layer.gatherReads.length > 0) {
      replicaGathers(layer, packedValues, projection, gatherIndices, gatherMasses)
    }
    takePhase('gather')
    for (let gateRow = 0; gateRow < layer.gateRows.length; gateRow++) {
      const outputRow = layer.gateRows[gateRow]!
      projection[outputRow] = Math.fround(
        projection[outputRow]! * Math.max(0, projection[outputSize + gateRow]!),
      )
    }
    packedValues.set(projection.subarray(0, outputSize), availableValues)
    availableValues += outputSize
    takePhase('gatesAndAppend')
  }
  const values = new Float32Array(width)
  for (let packedIndex = 0; packedIndex < wireOrder.length; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  takePhase('copyOut')
  return values
}

type StudyResult = {
  variant: string
  mode: string
  medianNs: number
  phases?: Record<string, number>
}

function runVariant(variant: string, mode: string): StudyResult {
  const {circuit, reads, valueWire} = buildLibraryCircuit(slotCount, readCount)
  const program = circuit.compileTensorProgram(reads, mode === 'on')
  validateTensorProgram(circuit, program)
  circuit.tensorProgram = program
  const source = new Float32Array(circuit.sourceSize)
  fillLibrarySource(source, slotCount, readCount, 3)

  // Correctness first: whichever variant runs must reproduce the reference.
  const reference = circuit.evaluateReference(source)
  const check = (values: Float32Array) => {
    for (const read of reads) {
      const expected = source[valueWire(0, 3)]!
      if (!sameNumericValue(values[read]!, reference[read]!)
          || !sameNumericValue(reference[read]!, expected)) {
        throw new Error(`${variant} ${mode}: read mismatch`)
      }
    }
  }

  // The lowered program has no boolean rows in this library shape, so the
  // replicas (which skip the boolean pass for brevity) stay faithful.
  for (const layer of program.layers) {
    if (layer.booleanRows.length > 0) throw new Error('replica does not model boolean rows')
  }

  let rotatingSlot = 3
  const rotate = () => {
    source[rotatingSlot] = 0
    rotatingSlot = (rotatingSlot + 1) % slotCount
    source[rotatingSlot] = 1
  }

  if (variant === 'phases') {
    check(replicaPhased(source, program, {}))
    for (let warm = 0; warm < warmupRuns; warm++) {
      rotate()
      replicaPhased(source, program, {})
    }
    const phases: Record<string, number> = {}
    const start = Bun.nanoseconds()
    for (let run = 0; run < timedRuns; run++) {
      rotate()
      replicaPhased(source, program, phases)
    }
    const totalNs = Bun.nanoseconds() - start
    for (const name of Object.keys(phases)) phases[name] = phases[name]! / timedRuns
    return {variant, mode, medianNs: totalNs / timedRuns, phases}
  }

  const evaluate = variant === 'real'
    ? () => circuit.evaluateTensor(source)
    : variant === 'extracted'
      ? () => replicaExtracted(source, program)
      : () => replicaMonolithic(source, program)
  check(evaluate())
  const [medianNs] = interleavedMedianNanoseconds([() => {
    rotate()
    evaluate()
  }], timedRuns, warmupRuns)
  return {variant, mode, medianNs: medianNs!}
}

// Subprocess mode: one (variant, mode) pair, printed as JSON.
if (process.argv.length === 4) {
  console.log(JSON.stringify(runVariant(process.argv[2]!, process.argv[3]!)))
  process.exit(0)
}

const combinations: [string, string][] = [
  ['real', 'off'],
  ['real', 'on'],
  ['extracted', 'on'],
  ['monolithic', 'on'],
  ['phases', 'off'],
  ['phases', 'on'],
]
const results: StudyResult[] = []
for (const [variant, mode] of combinations) {
  const child = Bun.spawnSync({
    cmd: ['bun', import.meta.path, variant, mode],
    stdout: 'pipe',
    stderr: 'inherit',
  })
  if (!child.success) throw new Error(`${variant} ${mode} failed`)
  results.push(JSON.parse(child.stdout.toString()) as StudyResult)
}

const microseconds = (nanoseconds: number) => (nanoseconds / 1_000).toFixed(1)
console.log(`N=${slotCount} T=${readCount} library, ${timedRuns} timed runs per subprocess`)
for (const result of results) {
  if (result.phases === undefined) {
    console.log(`${result.variant} executor, lowering ${result.mode}: ${microseconds(result.medianNs)} µs`)
  } else {
    const phaseText = Object.entries(result.phases)
      .map(([name, ns]) => `${name} ${microseconds(ns)}`)
      .join(' | ')
    console.log(
      `phase replica, lowering ${result.mode}: mean ${microseconds(result.medianNs)} µs`
        + ` (${phaseText})`,
    )
  }
}
const extracted = results.find(result => result.variant === 'extracted')!
const monolithic = results.find(result => result.variant === 'monolithic')!
console.log(
  `monolithic / extracted: ${(monolithic.medianNs / extracted.medianNs).toFixed(1)}x`,
)
