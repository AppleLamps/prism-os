// Three builder steps that change what a circuit costs before the compiler runs.
//
// 1. Constant folding. Each item's rank among items is the number of items
//    narrower than it, `rank[item] = Σ other [width[other] < width[item]]`.
//    With widths known when building, every comparison is computed at build
//    time and nothing is left to run. With widths in source cells, every pair
//    of items needs its own comparison: n² work.
// 2. The form of a product. `multiply(a, b)` is 1 operation when one operand's
//    declared range is nonnegative, and 3 operations when neither operand's
//    is. A range declared after the product was built doesn't change the product.
// 3. Where constant folding stops. A number known while building is free as a
//    coefficient. Passed to `multiply` as a wire of its own, it stays an
//    operation, because `multiply`, `select`, `roundAffine`, `emitMinimum` and
//    `emitMaximum` keep their operands as wires and the builder doesn't fold
//    through them.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'

// [left < right] for integer-valued wires: relu(d) - relu(d - 1) with d = right - left.
function lessThan(circuit: Circuit, left: Wire, right: Wire): Wire {
  const atLeastOne = circuit.reglu([], 1, [[right, 1], [left, -1]], 0)
  const atLeastTwo = circuit.reglu([], 1, [[right, 1], [left, -1]], -1)
  return circuit.affine([[atLeastOne, 1], [atLeastTwo, -1]])
}

export type RankCircuit = {circuit: Circuit, ranks: Wire[]}

export function buildRanksFromConstants(widths: readonly number[]): RankCircuit {
  const circuit = new Circuit(1)
  const widthWires = widths.map(width => circuit.affine([], width))
  const ranks = widthWires.map((width, item) => circuit.affine(
    widthWires.flatMap((other, otherItem): [Wire, number][] =>
      otherItem === item ? [] : [[lessThan(circuit, other, width), 1]]),
  ))
  return {circuit, ranks}
}

// Source layout: one integer width per item.
export function buildRanksFromCells(itemCount: number): RankCircuit {
  const circuit = new Circuit(itemCount)
  for (let item = 0; item < itemCount; item++) circuit.assumeRange(item, 0, 4096)
  const ranks = Array.from({length: itemCount}, (_, item) => circuit.affine(
    Array.from({length: itemCount}, (_, other) => other).flatMap((other): [Wire, number][] =>
      other === item ? [] : [[lessThan(circuit, other, item), 1]]),
  ))
  return {circuit, ranks}
}

export function rankReference(widths: ArrayLike<number>): number[] {
  return Array.from({length: widths.length}, (_, item) => {
    let rank = 0
    for (let other = 0; other < widths.length; other++) {
      if (other !== item && widths[other]! < widths[item]!) rank++
    }
    return rank
  })
}

// Source layout: velocity, timestep.
export function buildVelocityStep(declareTimestepFirst: boolean): {circuit: Circuit, distance: Wire} {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, -4096, 4096)
  if (declareTimestepFirst) circuit.assumeRange(1, 0, 0.032)
  const distance = circuit.multiply(0, 1)
  if (!declareTimestepFirst) circuit.assumeRange(1, 0, 0.032)
  return {circuit, distance}
}

// `distance = velocity * 0.004`, a fixed 4 ms step known while building.
// Source layout: velocity.
export const fixedTimestep = 0.004

export function buildFixedTimestepProduct(form: 'weight' | 'constant wire'): {circuit: Circuit, distance: Wire} {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, -4096, 4096)
  const distance = form === 'weight'
    ? circuit.affine([[0, fixedTimestep]])
    : circuit.multiply(0, circuit.affine([], fixedTimestep))
  return {circuit, distance}
}
