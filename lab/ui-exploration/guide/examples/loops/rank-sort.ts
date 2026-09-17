// Ranks instead of sorting, and an incremental rank update when one item moves.
//
// JS:  const order = items.map((_, item) => item).sort((left, right) => keys[left] - keys[right] || left - right)
//      and then each item's top is the sum of the heights before it in `order`.
//
// Host contract: keys are integers in 0..65,535, e.g. a date as a day number. Heights are multiples
// of 1/4 px in 0..1024, and the total height stays below 2^21 px.
import {Circuit, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {emitIntegerAtLeastZero} from './kit.ts'

export function rankSortReference(keys: ArrayLike<number>, heights: ArrayLike<number>) {
  const itemCount = keys.length
  const order = Array.from({length: itemCount}, (_, item) => item)
    .sort((left, right) => keys[left]! - keys[right]! || left - right)
  const ranks = Array<number>(itemCount)
  const itemTops = Array<number>(itemCount)
  let top = 0
  order.forEach((item, position) => {
    ranks[item] = position
    itemTops[item] = top
    top += heights[item]!
  })
  return {order, ranks, itemTops, sortedHeights: order.map(item => heights[item]!)}
}

// Source layout: cells 0..n-1 are keys, cells n..2n-1 are heights.
export function buildRankSort(itemCount: number) {
  const circuit = new Circuit(2 * itemCount)
  const keys = Array.from({length: itemCount}, (_, item) => circuit.source(item))
  const heights = Array.from({length: itemCount}, (_, item) => circuit.source(itemCount + item))
  for (const key of keys) circuit.assumeRange(key, 0, 65_535)
  for (const height of heights) circuit.assumeRange(height, 0, 1024)

  // earlierFirst[earlier][later] = [keys[earlier] <= keys[later]]: does the earlier item come first?
  // Equal keys keep their original order, as in a stable sort. The later item comes first exactly
  // when this bit is 0, so n(n - 1)/2 comparisons give the order of every pair, and no comparison reads another.
  const earlierFirst: Wire[][] = keys.map(() => [])
  for (let later = 1; later < itemCount; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      earlierFirst[earlier]![later] = emitIntegerAtLeastZero(circuit, [[asWire(keys[later]!), 1], [asWire(keys[earlier]!), -1]], 0)
    }
  }

  // ranks[item] = how many items come before it.
  const ranks = keys.map((_, item) => {
    const terms: [Wire, number][] = []
    let bias = 0
    for (let other = 0; other < itemCount; other++) {
      if (other < item) terms.push([earlierFirst[other]![item]!, 1])
      if (other > item) {
        terms.push([earlierFirst[item]![other]!, -1])
        bias += 1
      }
    }
    const rank = circuit.roundAffine(terms, bias)
    circuit.assumeRange(rank, 0, itemCount - 1)
    return rank
  })

  // itemTops[item] = the sum of the heights of the items that come before it: one product per pair.
  const itemTops = keys.map((_, item) => {
    const terms: [Wire, number][] = []
    for (let other = 0; other < itemCount; other++) {
      if (other < item) terms.push([circuit.multiply(earlierFirst[other]![item]!, asWire(heights[other]!)), 1])
      if (other > item) {
        terms.push([asWire(heights[other]!), 1])
        terms.push([circuit.multiply(earlierFirst[item]![other]!, asWire(heights[other]!)), -1])
      }
    }
    return circuit.roundAffine(terms)
  })

  // atPosition[position][item] = [ranks[item] == position], from shared ramps relu(rank - k):
  // [rank == p] = relu(rank - p + 1) - 2 relu(rank - p) + relu(rank - p - 1), exact for integers.
  // For one position these bits are a one-hot over items (a column of the permutation matrix), so
  // "the height at sorted position p" is a masked sum that the compiler lowers to one indexed read.
  const ramps = ranks.map(rank => Array.from({length: itemCount + 2}, (_, offset) => circuit.reglu([], 1, [[rank, 1]], 1 - offset)))
  const sortedHeights = Array.from({length: itemCount}, (_, position) => {
    const atPosition = ramps.map(itemRamps => {
      const bit = circuit.roundAffine([[itemRamps[position]!, 1], [itemRamps[position + 1]!, -2], [itemRamps[position + 2]!, 1]])
      circuit.assumeRange(bit, 0, 1)
      return bit
    })
    circuit.assumeOneHot(atPosition)
    return circuit.affine(atPosition.map((bit, item) => [circuit.multiply(asWire(heights[item]!), bit), 1] as const))
  })
  return {circuit, keys, heights, ranks, itemTops, sortedHeights}
}

// When a drag moves one item from rank fromRank to rank toRank, only the items in between change
// rank, by one each. That's a few comparisons per item against two shared values.
//
// JS:  order.splice(fromRank, 1); order.splice(toRank, 0, draggedItem)
export function moveRanksReference(ranks: ArrayLike<number>, fromRank: number, toRank: number): number[] {
  const order: number[] = []
  for (let item = 0; item < ranks.length; item++) order[ranks[item]!] = item
  const dragged = order.splice(fromRank, 1)[0]!
  order.splice(toRank, 0, dragged)
  const nextRanks = Array<number>(ranks.length)
  order.forEach((item, rank) => {
    nextRanks[item] = rank
  })
  return nextRanks
}

// Source layout: cells 0..n-1 hold each item's rank (a permutation of 0..n-1), cell n holds
// fromRank and cell n + 1 holds toRank.
export function buildMoveRanks(itemCount: number) {
  const circuit = new Circuit(itemCount + 2)
  const ranks = Array.from({length: itemCount}, (_, item) => circuit.source(item))
  const fromRank = itemCount
  const toRank = itemCount + 1
  for (const wire of [...ranks, fromRank, toRank]) circuit.assumeRange(asWire(wire), 0, itemCount - 1)
  const rankShift = circuit.roundAffine([[asWire(toRank), 1], [asWire(fromRank), -1]])
  const nextRanks = ranks.map(rank => {
    const afterFrom = emitIntegerAtLeastZero(circuit, [[asWire(rank), 1], [asWire(fromRank), -1]], -1) // [rank > fromRank]
    const beforeFrom = emitIntegerAtLeastZero(circuit, [[asWire(fromRank), 1], [asWire(rank), -1]], -1) // [rank < fromRank]
    const atOrBeforeTo = emitIntegerAtLeastZero(circuit, [[asWire(toRank), 1], [asWire(rank), -1]], 0) // [rank <= toRank]
    const atOrAfterTo = emitIntegerAtLeastZero(circuit, [[asWire(rank), 1], [asWire(toRank), -1]], 0) // [rank >= toRank]
    // The AND of two bits is relu(a + b - 1).
    const shiftsUp = circuit.reglu([], 1, [[afterFrom, 1], [atOrBeforeTo, 1]], -1) // rank in (fromRank, toRank]
    const shiftsDown = circuit.reglu([], 1, [[beforeFrom, 1], [atOrAfterTo, 1]], -1) // rank in [toRank, fromRank)
    const isDragged = circuit.roundAffine([[afterFrom, -1], [beforeFrom, -1]], 1) // [rank == fromRank]
    circuit.assumeRange(isDragged, 0, 1)
    const nextRank = circuit.roundAffine([[asWire(rank), 1], [shiftsUp, -1], [shiftsDown, 1], [circuit.multiply(rankShift, isDragged), 1]])
    circuit.assumeRange(nextRank, 0, itemCount - 1)
    return nextRank
  })
  return {circuit, ranks, fromRank, toRank, nextRanks}
}
