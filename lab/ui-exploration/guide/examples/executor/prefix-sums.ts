// Running totals of row heights, `rowBottom[k] = height[0] + ... + height[k]`,
// written five ways whose costs grow differently:
//
// - chain: one 2-term sum per row, each reading the previous total. n operations, n layers.
// - triangle: one wide sum per row over every earlier height. n operations, 1 layer, n²/2 weights.
// - ordinary affine chain: the chain written with `affine`, which the builder
//   composes into sums of up to 4 terms. n operations, about n/3 layers.
// - Brent-Kung network: about 2n operations, about 2 log2(n) layers.
// - Kogge-Stone network: about n log2(n) operations, log2(n) layers.
//
// Every form adds exact quarter-pixel heights exactly. With fractional
// heights, the chain and the triangle take the same FP32 steps as a plain
// sequential loop, and the networks take their own steps.
import {Circuit, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'

export type PrefixCircuit = {circuit: Circuit, rowBottoms: Wire[]}

function createHeightCircuit(rowCount: number): Circuit {
  const circuit = new Circuit(rowCount)
  for (let row = 0; row < rowCount; row++) circuit.assumeRange(asWire(row), 0, 1024)
  return circuit
}

export function buildChain(rowCount: number): PrefixCircuit {
  const circuit = createHeightCircuit(rowCount)
  const rowBottoms: Wire[] = [asWire(0)]
  for (let row = 1; row < rowCount; row++) {
    rowBottoms.push(circuit.roundAffine([[rowBottoms[row - 1]!, 1], [asWire(row), 1]]))
  }
  return {circuit, rowBottoms}
}

export function buildTriangle(rowCount: number): PrefixCircuit {
  const circuit = createHeightCircuit(rowCount)
  const rowBottoms: Wire[] = [asWire(0)]
  for (let row = 1; row < rowCount; row++) {
    rowBottoms.push(circuit.roundAffine(
      Array.from({length: row + 1}, (_, earlier): [Wire, number] => [asWire(earlier), 1]),
    ))
  }
  return {circuit, rowBottoms}
}

export function buildOrdinaryAffineChain(rowCount: number): PrefixCircuit {
  const circuit = createHeightCircuit(rowCount)
  const rowBottoms: Wire[] = [asWire(0)]
  for (let row = 1; row < rowCount; row++) {
    rowBottoms.push(circuit.affine([[rowBottoms[row - 1]!, 1], [asWire(row), 1]]))
  }
  return {circuit, rowBottoms}
}

// A prefix network as levels of combine steps. Within a level every step reads
// values from before the level: [target, left] means
// `total[target] = total[left] + total[target]`.
export type PrefixNetwork = (readonly [target: number, left: number])[][]

export function brentKungNetwork(rowCount: number): PrefixNetwork {
  const levels: PrefixNetwork = []
  let span = 1
  for (; span < rowCount; span *= 2) {
    const level: [number, number][] = []
    for (let target = 2 * span - 1; target < rowCount; target += 2 * span) {
      level.push([target, target - span])
    }
    levels.push(level)
  }
  for (span = span / 4; span >= 1; span /= 2) {
    const level: [number, number][] = []
    for (let target = 3 * span - 1; target < rowCount; target += 2 * span) {
      level.push([target, target - span])
    }
    if (level.length > 0) levels.push(level)
  }
  return levels
}

export function koggeStoneNetwork(rowCount: number): PrefixNetwork {
  const levels: PrefixNetwork = []
  for (let span = 1; span < rowCount; span *= 2) {
    const level: [number, number][] = []
    for (let target = span; target < rowCount; target++) level.push([target, target - span])
    levels.push(level)
  }
  return levels
}

export function buildNetwork(rowCount: number, network: PrefixNetwork): PrefixCircuit {
  const circuit = createHeightCircuit(rowCount)
  const totals: Wire[] = Array.from({length: rowCount}, (_, row) => circuit.source(row))
  for (const level of network) {
    const previous = [...totals]
    for (const [target, left] of level) {
      totals[target] = circuit.roundAffine([[previous[left]!, 1], [previous[target]!, 1]])
    }
  }
  return {circuit, rowBottoms: totals}
}

const f = Math.fround

export function sequentialReference(heights: Float32Array): Float32Array {
  const rowBottoms = new Float32Array(heights.length)
  let total = 0
  for (let row = 0; row < heights.length; row++) {
    total = f(total + heights[row]!)
    rowBottoms[row] = total
  }
  return rowBottoms
}

export function networkReference(heights: Float32Array, network: PrefixNetwork): Float32Array {
  const totals = Float32Array.from(heights)
  for (const level of network) {
    const previous = Float32Array.from(totals)
    for (const [target, left] of level) totals[target] = f(previous[left]! + previous[target]!)
  }
  return totals
}
