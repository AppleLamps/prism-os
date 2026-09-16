// Hard attention over table positions with parabola keys: the same scores as
// soft-attention.ts, score[j] = 2 * query * j - j², but the weights are the
// one-hot of the highest score instead of a softmax. emitArgmax builds that
// one-hot with a tournament of pairwise comparisons, declares it as a one-hot,
// and the masked sum over it lowers to a gather.
import {Circuit, emitArgmax, asWire} from '../../../../../numeric-ui-core.ts'
import {emitMaskedSum} from './one-hot-read.ts'

// Plain JS: the entry with the highest score; ties go to the lower position.
export function nearestPositionRead(table: readonly number[], query: number): number {
  let bestPosition = 0
  let bestScore = 0
  for (let position = 1; position < table.length; position++) {
    const score = 2 * query * position - position * position
    if (score > bestScore) {
      bestPosition = position
      bestScore = score
    }
  }
  return table[bestPosition]!
}

// Source table: [query, table[0], ..., table[count - 1]].
export function buildHardAttentionRead(count: number) {
  const circuit = new Circuit(1 + count)
  const query = circuit.source(0)
  const table = Array.from({length: count}, (_, position) => circuit.source(1 + position))
  circuit.assumeRange(query, 0, count - 1)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const unit = circuit.affine([], 1)
  // emitArgmax needs scores within 0..1. score[j] + (count - 1)² lies within
  // 0..2 * (count - 1)², and a power-of-two scale keeps the scaling exact.
  const scoreOffset = (count - 1) ** 2
  const scale = 2 ** -Math.ceil(Math.log2(2 * scoreOffset))
  const scores = table.map((_, position) => {
    const score = circuit.roundAffine([[query, 2 * position * scale]], (scoreOffset - position * position) * scale)
    circuit.assumeRange(score, 0, 1)
    return score
  })
  const {selected} = emitArgmax(circuit, scores, unit)
  const read = emitMaskedSum(circuit, selected, table)
  const source = (queryValue: number, tableValues: readonly number[]) => Float32Array.from([queryValue, ...tableValues])
  return {circuit, query, table, selected, read, source}
}

// Plain JS: the target position nearest to pointerX; ties go to the lower target index.
export function nearestTargetReference(targetPositions: readonly number[], pointerX: number): number {
  let bestTarget = 0
  let bestDistance = Math.abs(pointerX - targetPositions[0]!)
  for (let target = 1; target < targetPositions.length; target++) {
    const distance = Math.abs(pointerX - targetPositions[target]!)
    if (distance < bestDistance) {
      bestTarget = target
      bestDistance = distance
    }
  }
  return targetPositions[bestTarget]!
}

// Hard attention whose keys are runtime values: snap to the nearest of count target
// positions that come from layout, e.g. card left edges. Target j's key is
// (2 × targetX[j], -targetX[j]²) and the query is (pointerX, 1), so
// score[j] = 2 × pointerX × targetX[j] - targetX[j]² = pointerX² - (pointerX - targetX[j])²,
// which is largest at the nearest target. Each score now needs two products.
//
// Source table: [pointerX, targetX[0], ..., targetX[count - 1]], with pointerX on a
// 1/4 px grid and integer target positions within 0..maximumPosition. Then every score
// is exact in FP32, and two different scores differ by at least 1/2 before scaling.
export function buildRuntimeKeyHardAttention(count: number, maximumPosition: number) {
  const circuit = new Circuit(1 + count)
  const pointerX = circuit.source(0)
  const targetPositions = Array.from({length: count}, (_, target) => circuit.source(1 + target))
  circuit.assumeRange(pointerX, 0, maximumPosition)
  for (const wire of targetPositions) circuit.assumeRange(wire, 0, maximumPosition)
  const unit = circuit.affine([], 1)
  // score[j] lies within -maximumPosition²..maximumPosition², so shift it up by
  // maximumPosition² and scale it by a power of two into 0..1.
  const scoreOffset = maximumPosition ** 2
  const scale = 2 ** -Math.ceil(Math.log2(2 * scoreOffset))
  const scores = targetPositions.map(target => {
    const pointerTimesTarget = circuit.multiply(pointerX, asWire(target))
    const targetSquared = circuit.multiply(asWire(target), target)
    const score = circuit.roundAffine([[pointerTimesTarget, 2 * scale], [targetSquared, -scale]], scoreOffset * scale)
    circuit.assumeRange(score, 0, 1)
    return score
  })
  const {selected} = emitArgmax(circuit, scores, unit)
  const snapX = emitMaskedSum(circuit, selected, targetPositions)
  const source = (pointerXValue: number, targetPositionValues: readonly number[]) =>
    Float32Array.from([pointerXValue, ...targetPositionValues])
  return {circuit, pointerX, targetPositions, selected, snapX, source}
}
