import type {Circuit, Wire} from '../../../../../numeric-ui-core.ts'

export type ProgramSize = {
  liveOperations: number
  // The longest chain of operations that must run one after another.
  layers: number
  storedWeights: number
  gatherReads: number
  // How many live operations belong to `trackedWires`, e.g. the wires that build integer one-hots.
  trackedOperations: number
}

export function programSize(circuit: Circuit, roots: readonly Wire[], trackedWires: ReadonlySet<number> = new Set()): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
  }
  let trackedOperations = 0
  for (let position = program.sourceSize; position < program.wireOrder.length; position++) {
    if (trackedWires.has(program.wireOrder[position]!)) trackedOperations++
  }
  return {
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    trackedOperations,
  }
}
