import type {Circuit} from '../../numeric-ui-core.ts'

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

// The repo's agreement standard for compiled backends is ===, which treats
// +0 and -0 as equal; Object.is additionally treats NaN as equal to itself so
// a wire that legitimately computes NaN in both evaluators still counts as
// matching. Any other difference is a real mismatch.
export function sameNumericValue(left: number, right: number) {
  return left === right || Object.is(left, right)
}

export type GatherStatistics = {
  readCount: number
  computeCount: number
  slotCount: number
  storedWeightCount: number
  weightBytes: number
  biasBytes: number
  bookkeepingBytes: number
  gatherBytes: number
  layerCount: number
  valueCount: number
}

export function gatherStatistics(program: CompiledProgram): GatherStatistics {
  let readCount = 0
  let computeCount = 0
  let storedWeightCount = 0
  let weightBytes = 0
  let biasBytes = 0
  let bookkeepingBytes = program.roots.byteLength + program.wireOrder.byteLength
  let gatherBytes = 0
  for (const layer of program.layers) {
    readCount += layer.gatherReads.length
    computeCount += layer.gatherComputes.length
    storedWeightCount += layer.weights.length
    weightBytes += layer.weights.byteLength
    biasBytes += layer.bias.byteLength
    bookkeepingBytes +=
      layer.inputIndices.byteLength
      + layer.gateRows.byteLength
      + layer.booleanRows.byteLength
      + layer.rowOffsets.byteLength
      + layer.columns.byteLength
    for (const compute of layer.gatherComputes) {
      // The bit table plus the slot number (stored as one 32-bit value).
      gatherBytes += compute.bitPositions.byteLength + 4
    }
    for (const read of layer.gatherReads) {
      // The candidate table plus row, slot, and mask flag (three 32-bit values).
      gatherBytes += read.candidatePositions.byteLength + 12
    }
  }
  return {
    readCount,
    computeCount,
    slotCount: program.gatherSlotCount,
    storedWeightCount,
    weightBytes,
    biasBytes,
    bookkeepingBytes,
    gatherBytes,
    layerCount: program.layers.length,
    valueCount: program.valueCount,
  }
}

// The set of wires whose defining operation was lowered to a gather read.
export function loweredWires(program: CompiledProgram): Set<number> {
  const wires = new Set<number>()
  let availableValues = program.sourceSize
  for (const layer of program.layers) {
    for (const read of layer.gatherReads) {
      wires.add(program.wireOrder[availableValues + read.row]!)
    }
    availableValues += layer.outputSize
  }
  return wires
}

// Time several runners round-robin inside one loop, so JIT tiering, garbage
// collection, and thermal drift hit every runner equally instead of biasing
// whichever happened to be measured last. Each run is timed individually so
// outliers (garbage collection pauses) fall out of the medians.
export function interleavedMedianNanoseconds(
  runners: readonly (() => void)[],
  runCount: number,
  warmupCount: number,
) {
  for (let index = 0; index < warmupCount; index++) {
    for (const run of runners) run()
  }
  const samples = runners.map(() => new Float64Array(runCount))
  for (let index = 0; index < runCount; index++) {
    for (let runner = 0; runner < runners.length; runner++) {
      const start = Bun.nanoseconds()
      runners[runner]!()
      samples[runner]![index] = Bun.nanoseconds() - start
    }
  }
  return samples.map(runnerSamples => {
    runnerSamples.sort()
    return runnerSamples[runCount >> 1]!
  })
}
