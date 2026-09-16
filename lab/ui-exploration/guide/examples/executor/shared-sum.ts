// A wide sum that every item reads, built two ways.
//
// UI job: every item is placed relative to the total height of all items, e.g.
// `labelTop[item] = 0.5 * totalHeight + offset[item]`.
//
// - Shared: `totalHeight` is one operation, and each item's label top reads it
//   as one term. The builder keeps a sum of 4 or more terms as its own wire
//   (`affineShareThreshold` in numeric-ui-core.ts), so this is the default.
// - Copied: each item's label top is one sum with a term for every height. That is what
//   the builder does on its own for sums of fewer than 4 terms, and what it did
//   for every sum before the threshold existed.
import {Circuit, type Wire, asWire} from '../../../../../numeric-ui-core.ts'

export type ItemCircuit = {circuit: Circuit, labelTops: Wire[]}

// Source layout: heights in cells 0..itemCount-1, offsets in cells itemCount..2*itemCount-1.
function createItemCircuit(itemCount: number): Circuit {
  const circuit = new Circuit(2 * itemCount)
  for (let wire = 0; wire < 2 * itemCount; wire++) circuit.assumeRange(asWire(wire), 0, 1024)
  return circuit
}

export function buildSharedTotal(itemCount: number): ItemCircuit {
  const circuit = createItemCircuit(itemCount)
  const totalHeight = circuit.affine(
    Array.from({length: itemCount}, (_, item): [Wire, number] => [circuit.source(item), 1]),
  )
  const labelTops = Array.from({length: itemCount}, (_, item) =>
    circuit.affine([[totalHeight, 0.5], [circuit.source(itemCount + item), 1]]))
  return {circuit, labelTops}
}

export function buildCopiedTotal(itemCount: number): ItemCircuit {
  const circuit = createItemCircuit(itemCount)
  const labelTops = Array.from({length: itemCount}, (_, item) =>
    circuit.affine([
      ...Array.from({length: itemCount}, (_, other): [Wire, number] => [circuit.source(other), 0.5]),
      [circuit.source(itemCount + item), 1],
    ]))
  return {circuit, labelTops}
}

const f = Math.fround

// Plain JS with the executor's FP32 steps for the shared form: the total adds
// heights in item order, then each label top adds its offset (the lower wire
// number comes first) and then half the total.
export function sharedTotalReference(heights: Float32Array, offsets: Float32Array): Float32Array {
  let totalHeight = 0
  for (const height of heights) totalHeight = f(totalHeight + height)
  return offsets.map(offset => f(offset + f(0.5 * totalHeight)))
}

// The copied form adds half of each height in item order, then the offset.
export function copiedTotalReference(heights: Float32Array, offsets: Float32Array): Float32Array {
  return offsets.map(offset => {
    let labelTop = 0
    for (const height of heights) labelTop = f(labelTop + f(0.5 * height))
    return f(labelTop + offset)
  })
}

// Float64, the way ordinary JS UI code computes it.
export function float64Reference(heights: Float32Array, offsets: Float32Array): Float64Array {
  let totalHeight = 0
  for (const height of heights) totalHeight += height
  return Float64Array.from(offsets, offset => 0.5 * totalHeight + offset)
}
