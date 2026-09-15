// Counting and comparison helpers shared by the tests and report.ts.
import type {Circuit, CompileOptions} from './numeric-ui-core.ts'

export type CompiledProgram = ReturnType<Circuit['compileTensorProgram']>

// Seeded hash, copied from numeric-ui-core.test.ts so every run is deterministic.
export function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

export function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

// The repo's agreement standard is ===, which treats +0 and -0 as equal;
// Object.is also lets a wire that computes NaN in both evaluators match.
export function sameNumericValue(left: number, right: number) {
  return left === right || Object.is(left, right)
}

// How one circuit gets compiled for a measurement.
export type CompileMode = {
  label: string
  lowerGathers: boolean
  options: CompileOptions
}

export const compileModes = {
  // Masked sums stay dense rows of products.
  dense: {label: 'dense', lowerGathers: false, options: {}},
  // The shared runtime's gather lowering: the index comes from a dot over the N
  // bits, and operations keep their build-time depths.
  gather: {
    label: 'gather',
    lowerGathers: true,
    options: {lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false},
  },
  // Gather lowering plus the relu one-hot recognition: the index comes from the index wire.
  lowered: {label: 'lowered', lowerGathers: true, options: {lowerIndexOneHots: true, inferBitFamilies: false}},
  // Everything this prototype adds, for circuits built with the index read instruction.
  all: {label: 'all', lowerGathers: true, options: {lowerIndexOneHots: true, inferBitFamilies: true}},
  // All of the above, plus selects with a proven-bit gate lowered as two-member reads.
  allWithSelects: {
    label: 'all with selects',
    lowerGathers: true,
    options: {lowerIndexOneHots: true, inferBitFamilies: true, lowerSelects: true},
  },
} as const satisfies Record<string, CompileMode>

export function compileWith(circuit: Circuit, roots: readonly number[], mode: CompileMode): CompiledProgram {
  return circuit.compileTensorProgram(roots, mode.lowerGathers, mode.options)
}

export type ProgramStatistics = {
  sourceCells: number
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
  bitComputes: number
  indexComputes: number
  bitTableEntries: number
  indexReads: number
  candidateTableEntries: number
}

// Counts from a compiled program. Stored weights are sparse matrix weights;
// table entries are integer bookkeeping (packed positions), not FP32 weights,
// and a table shared by several reads counts once.
export function programStatistics(program: CompiledProgram): ProgramStatistics {
  let storedWeights = 0
  let gatherReads = 0
  let bitComputes = 0
  let indexComputes = 0
  let bitTableEntries = 0
  let indexReads = 0
  let candidateTableEntries = 0
  const countedTables = new Set<ArrayLike<number>>()
  const countTable = (table: ArrayLike<number>) => {
    if (countedTables.has(table)) return
    countedTables.add(table)
    candidateTableEntries += table.length
  }
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    indexReads += layer.indexReads.length
    for (const compute of layer.gatherComputes) {
      if (compute.indexPosition >= 0) {
        indexComputes++
      } else {
        bitComputes++
        bitTableEntries += compute.bitPositions.length
      }
    }
    for (const read of layer.gatherReads) countTable(read.candidatePositions)
    for (const read of layer.indexReads) countTable(read.candidatePositions)
  }
  return {
    sourceCells: program.sourceSize,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    bitComputes,
    indexComputes,
    bitTableEntries,
    indexReads,
    candidateTableEntries,
  }
}

// Evaluate the reference and the given tensor program on one source table and
// count live wires that disagree.
export function countWireMismatches(
  circuit: Circuit,
  program: CompiledProgram,
  source: Float32Array,
): {mismatches: number, reference: Float32Array, tensor: Float32Array} {
  const reference = circuit.evaluateReference(source)
  const previous = circuit.tensorProgram
  circuit.tensorProgram = program
  const tensor = circuit.evaluateTensor(source)
  circuit.tensorProgram = previous
  let mismatches = 0
  for (const wire of program.wireOrder) {
    if (!sameNumericValue(tensor[wire]!, reference[wire]!)) mismatches++
  }
  return {mismatches, reference, tensor}
}

// Median of several timed batches, in microseconds per call. Rough: other
// processes share the machine.
export function medianMicroseconds(run: () => void, iterations: number, repeats = 5): number {
  const samples: number[] = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let warm = 0; warm < Math.min(50, iterations); warm++) run()
    const started = Bun.nanoseconds()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((Bun.nanoseconds() - started) / 1000 / iterations)
  }
  samples.sort((left, right) => left - right)
  return Number(samples[repeats >> 1]!.toPrecision(3))
}
