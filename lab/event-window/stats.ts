// Circuit cost measurement: operation counts by atom kind, dependency depth,
// and the compiled tensor program's stored weights and layer shape.

import {validateTensorProgram} from '../../src/runtime/numeric-ui-core.ts'
import type {EventWindowBuild} from './circuit.ts'

export type CircuitCost = {
  sourceCells: number
  operations: number
  affine: number
  reglu: number
  boolean: number
  depth: number
  layerCount: number
  activations: number
  storedWeights: number
  maxLayerWidth: number
}

export function measureCircuitCost(build: EventWindowBuild): CircuitCost {
  const {circuit, output} = build
  let affine = 0
  let reglu = 0
  let booleanCount = 0
  let depth = 0
  for (const operation of circuit.operations) {
    if (operation.kind === 'affine') affine++
    else if (operation.kind === 'reglu') reglu++
    else booleanCount++
    depth = Math.max(depth, operation.depth)
  }
  const program = circuit.compileTensorProgram([
    ...output.nextSource,
    ...output.displayed,
    ...output.dragOwner,
  ])
  validateTensorProgram(circuit, program)
  let storedWeights = 0
  let maxLayerWidth = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    maxLayerWidth = Math.max(maxLayerWidth, layer.outputSize + layer.gateRows.length)
  }
  return {
    sourceCells: circuit.sourceSize,
    operations: circuit.operations.length,
    affine,
    reglu,
    boolean: booleanCount,
    depth,
    layerCount: program.layers.length,
    activations: program.valueCount - program.sourceSize,
    storedWeights,
    maxLayerWidth,
  }
}
