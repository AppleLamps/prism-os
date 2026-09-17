// A map stage: an ordinary Circuit written once for one item, then run once per item.
//
// The stage's source cells are the shared values it reads (the same for every item, like shader
// uniforms), followed by the item's own fields (one Float32Array per field, one number per item).
// This is a small, simplified version of lab/ui-exploration/instanced-items/staged.ts and executor.ts.
// It compiles the stage once and evaluates the compiled program once per item. The prototype's executor
// instead generates one JS loop over items per stage, and computes the operations that read no
// per-item field once per frame.
import {Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

export type Range = readonly [minimum: number, maximum: number]

export type MapStage<S extends string, F extends string, O extends string> = {
  name: string
  circuit: Circuit
  shared: Record<S, Wire>
  fields: Record<F, Wire>
  outputs: Record<O, Wire>
  evaluate: (source: Float32Array) => Float32Array
}

export function buildMapStage<S extends string, F extends string, O extends string>(
  name: string,
  sharedRanges: Record<S, Range>,
  fieldRanges: Record<F, Range>,
  build: (circuit: Circuit, shared: Record<S, Wire>, item: Record<F, Wire>) => Record<O, Wire>,
): MapStage<S, F, O> {
  const sharedNames = Object.keys(sharedRanges) as S[]
  const fieldNames = Object.keys(fieldRanges) as F[]
  const circuit = new Circuit(sharedNames.length + fieldNames.length)
  const shared = {} as Record<S, Wire>
  sharedNames.forEach((key, wire) => {
    shared[key] = circuit.source(wire)
    circuit.assumeRange(shared[key], sharedRanges[key][0], sharedRanges[key][1])
  })
  const fields = {} as Record<F, Wire>
  fieldNames.forEach((key, position) => {
    fields[key] = circuit.source(sharedNames.length + position)
    circuit.assumeRange(fields[key], fieldRanges[key][0], fieldRanges[key][1])
  })
  const outputs = build(circuit, shared, fields)
  const outputNames = Object.keys(outputs) as O[]
  const evaluate = circuit.createTensorEvaluator(outputNames.map(key => outputs[key]))
  return {name, circuit, shared, fields, outputs, evaluate}
}

// Write the shared cells once, then for each item write its fields, evaluate, and copy the outputs out.
export function runMapStage<S extends string, F extends string, O extends string>(
  stage: MapStage<S, F, O>,
  sharedValues: Record<S, number>,
  fieldColumns: Record<F, Float32Array>,
  count: number,
): Record<O, Float32Array> {
  const source = new Float32Array(stage.circuit.sourceSize)
  for (const key of Object.keys(stage.shared) as S[]) source[stage.shared[key]] = sharedValues[key]
  const fieldNames = Object.keys(stage.fields) as F[]
  const outputNames = Object.keys(stage.outputs) as O[]
  const columns = {} as Record<O, Float32Array>
  for (const key of outputNames) columns[key] = new Float32Array(count)
  for (let item = 0; item < count; item++) {
    for (const key of fieldNames) source[stage.fields[key]] = fieldColumns[key][item]!
    const values = stage.evaluate(source)
    outputNames.forEach((key, position) => {
      columns[key][item] = values[position]!
    })
  }
  return columns
}

// Live operations are the operations some output depends on; layers are the longest chain of
// operations that must run one after another; stored weights are the coefficients the compiled program keeps.
export function measureCircuit(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  for (const layer of program.layers) storedWeights += layer.weights.length
  return {liveOperations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights}
}
