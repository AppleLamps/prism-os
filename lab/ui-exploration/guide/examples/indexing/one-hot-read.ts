// Reading table[index] as a one-hot masked sum: a vector of bits that is 1 only
// at the selected position, each table entry multiplied by its bit, then one sum.
import {Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

// Plain JS: the entry at floor(index), clamped to the table's ends.
export function clampedRead(table: readonly number[], index: number): number {
  const position = Math.min(Math.max(Math.floor(index), 0), table.length - 1)
  return table[position]!
}

// weight[j] = [index >= j] - [index >= j + 1], where [index >= j] is
// relu(index - j + 1) - relu(index - j), with [index >= 0] = 1 and
// [index >= count] = 0 so the ends clamp.
//
// For a whole-number index these weights are a one-hot. For a fractional index
// between j and j + 1 they are (1 - fraction) at j and fraction at j + 1, i.e.
// weight[j] = relu(1 - |index - j|), a tent-shaped weight over positions. So the
// same wires compute linear interpolation when the index isn't a whole number.
export function emitTentWeights(circuit: Circuit, index: Wire, count: number): Wire[] {
  if (count < 2) throw new Error('a table read needs at least two entries')
  // atLeast[j - 1] holds [index >= j] for j = 1..count-1.
  const atLeast: Wire[] = []
  for (let position = 1; position < count; position++) {
    const upper = circuit.reglu([], 1, [[index, 1]], 1 - position)
    const lower = circuit.reglu([], 1, [[index, 1]], -position)
    // Kept as its own operation with roundAffine, so every operation that reads the
    // bit gets the same rounded 0..1 value instead of a copy of the two ReLU terms.
    const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
    circuit.assumeRange(bit, 0, 1)
    atLeast.push(bit)
  }
  const weights: Wire[] = []
  for (let position = 0; position < count; position++) {
    const terms: [Wire, number][] = []
    let bias = 0
    if (position === 0) bias = 1
    else terms.push([atLeast[position - 1]!, 1])
    if (position < count - 1) terms.push([atLeast[position]!, -1])
    const weight = circuit.roundAffine(terms, bias)
    circuit.assumeRange(weight, 0, 1)
    weights.push(weight)
  }
  return weights
}

// sum over j of weight[j] * table[j], as one roundAffine sum in position order.
export function emitMaskedSum(circuit: Circuit, weights: readonly Wire[], table: readonly Wire[]): Wire {
  return circuit.roundAffine(weights.map((weight, position) =>
    [circuit.multiply(weight, table[position]!), 1] as const))
}

// A circuit whose source table is [index, table[0], ..., table[count - 1]].
// declareOneHot declares to the compiler that the weights are an exact one-hot,
// which lets the compiler lower the masked sum to a gather.
export function buildOneHotRead(count: number, options: {declareOneHot: boolean}) {
  const circuit = new Circuit(1 + count)
  const index = circuit.source(0)
  const table = Array.from({length: count}, (_, position) => circuit.source(1 + position))
  circuit.assumeRange(index, -4, count + 4)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const weights = emitTentWeights(circuit, index, count)
  if (options.declareOneHot) circuit.assumeOneHot(weights)
  const read = emitMaskedSum(circuit, weights, table)
  const source = (indexValue: number, tableValues: readonly number[]) => Float32Array.from([indexValue, ...tableValues])
  return {circuit, index, table, weights, read, source}
}
