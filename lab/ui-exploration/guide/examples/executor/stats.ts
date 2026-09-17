// Measures a compiled program: the cost model of the executor section.
import {type Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

export type ProgramStats = {
  // Live operations: values the executor computes on every evaluation.
  operations: number
  // Layers: the longest chain of operations that must run one after another.
  layers: number
  // Nonzero entries of the sparse matrices, summed over layers.
  storedWeights: number
  // The largest number of operations in one layer.
  widestLayer: number
  // The median number of operations per layer.
  medianLayerWidth: number
  // Masked sums the compiler turned into indexed reads.
  gatherReads: number
  // Integer positions stored for those reads: one bit position per member of
  // each one-hot group, plus one candidate position per member per read.
  tableEntries: number
}

export function measureProgram(
  circuit: Circuit,
  roots: readonly Wire[],
  lowerGathers = true,
): ProgramStats {
  const program = circuit.compileTensorProgram(roots, lowerGathers)
  let storedWeights = 0
  let widestLayer = 0
  let gatherReads = 0
  let tableEntries = 0
  const widths: number[] = []
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    widestLayer = Math.max(widestLayer, layer.outputSize)
    widths.push(layer.outputSize)
    gatherReads += layer.gatherReads.length
    for (const compute of layer.gatherComputes) tableEntries += compute.bitPositions.length
    for (const read of layer.gatherReads) tableEntries += read.candidatePositions.length
  }
  widths.sort((left, right) => left - right)
  return {
    operations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    widestLayer,
    medianLayerWidth: widths.length === 0 ? 0 : widths[Math.floor(widths.length / 2)]!,
    gatherReads,
    tableEntries,
  }
}

// Evaluates the program compiled with or without gather lowering and returns
// the requested roots. `evaluateTensor` compiles every operation as a root, so
// this assigns the program compiled for these roots instead.
export function evaluateCompiled(
  circuit: Circuit,
  roots: readonly Wire[],
  source: Float32Array,
  lowerGathers = true,
): Float32Array {
  circuit.tensorProgram = circuit.compileTensorProgram(roots, lowerGathers)
  const values = circuit.evaluateTensor(source)
  circuit.tensorProgram = null
  return Float32Array.from(roots, root => values[root]!)
}

export function formatStats(label: string, stats: ProgramStats): string {
  return `${label}: ${stats.operations} operations, ${stats.layers} layers, `
    + `${stats.storedWeights} stored weights, widest layer ${stats.widestLayer}, `
    + `${stats.gatherReads} gather reads, ${stats.tableEntries} table entries`
}
