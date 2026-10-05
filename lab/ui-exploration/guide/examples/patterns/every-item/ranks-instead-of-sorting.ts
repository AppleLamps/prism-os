// Ranks instead of sorting. An item's rank is how many items come before it: one comparison per pair of items
// gives which of the two comes first, all in the same layers, and each rank counts those bits. When one item
// moves, e.g. a dragged card, each card gets a bit that is 1 when the dragged card passes it, and the ranks
// update from those bits and two counts.
import {Circuit, emitCompare, type Wire, asWire} from '../../../../../../src/runtime/numeric-ui-core.ts'

// Host contract for ranks: keys are integers within 0..65,535, e.g. dates as day numbers, and heights are
// multiples of 1/4 px within 0..1,024, so every top is an exact FP32 sum while the total stays below 2^22 px.
export const keyMaximum = 65_535
export const heightMaximum = 1024

// JS: a stable sort, then each item's top is the sum of the heights of the items before it.
export function sortReference(keys: readonly number[], heights: readonly number[]) {
  const order = keys.map((_, item) => item).sort((left, right) => keys[left]! - keys[right]! || left - right)
  const ranks = Array<number>(keys.length)
  const itemTops = Array<number>(keys.length)
  let top = 0
  order.forEach((item, rank) => {
    ranks[item] = rank
    itemTops[item] = top
    top += heights[item]!
  })
  return {ranks, itemTops}
}

// Source table: keys[0..n-1], then heights[0..n-1].
export function buildRanks(itemCount: number) {
  const circuit = new Circuit(2 * itemCount)
  const keys = Array.from({length: itemCount}, (_, item) => item)
  const heights = Array.from({length: itemCount}, (_, item) => itemCount + item)
  for (const key of keys) {
    circuit.assumeRange(asWire(key), 0, keyMaximum)
    circuit.assumeGrid(asWire(key), 1)
  }
  for (const height of heights) {
    circuit.assumeRange(asWire(height), 0, heightMaximum)
    circuit.assumeGrid(asWire(height), 1 / 4)
  }

  // earlierFirst[earlier][later] = [keys[earlier] <= keys[later]], 1 when the earlier item comes first. Equal keys
  // keep their original order, like a stable sort. The later item comes first exactly when the bit is 0, so one
  // comparison per pair gives both directions, and no comparison reads another.
  const earlierFirst: Wire[][] = keys.map(() => [])
  for (let later = 1; later < itemCount; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      earlierFirst[earlier]![later] = emitCompare(circuit, asWire(keys[earlier]!), '<=', asWire(keys[later]!))
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

  // itemTops[item] = the sum of the heights of the items that come before it, one product per pair.
  const itemTops = keys.map((_, item) => {
    const terms: [Wire, number][] = []
    for (let other = 0; other < itemCount; other++) {
      if (other < item) terms.push([circuit.multiply(earlierFirst[other]![item]!, asWire(heights[other]!)), 1])
      if (other > item) terms.push([asWire(heights[other]!), 1], [circuit.multiply(earlierFirst[item]![other]!, asWire(heights[other]!)), -1])
    }
    return circuit.roundAffine(terms)
  })
  return {circuit, keys, heights, earlierFirst, ranks, itemTops}
}

// Host contract for a drag: card tops, card heights and pointerY are multiples of 1/64 px, and every card sits
// where last frame's stack layout put it, in rank order, so card midpoints never decrease along ranks.
export const positionMaximum = 65_536

export type DragInput = {
  ranks: readonly number[]
  cardTops: readonly number[]
  cardHeights: readonly number[]
  fromRank: number
  pointerY: number
}

// JS, from chenguini's draggable-cards (index.ts and swap-layout.ts), over the card ids in rank order. The
// demo's loops read each neighbor's destination from last frame, which cardTops holds.
export function dragReorderReference({ranks, cardTops, cardHeights, fromRank, pointerY}: DragInput) {
  const order: number[] = []
  ranks.forEach((rank, card) => {
    order[rank] = card
  })
  const midpoint = (card: number) => cardTops[card]! + cardHeights[card]! / 2
  let dragIndex = fromRank
  while (dragIndex > 0 && pointerY < midpoint(order[dragIndex - 1]!)) {
    ;[order[dragIndex], order[dragIndex - 1]] = [order[dragIndex - 1]!, order[dragIndex]!]
    dragIndex--
  }
  while (dragIndex < order.length - 1 && pointerY > midpoint(order[dragIndex + 1]!)) {
    ;[order[dragIndex], order[dragIndex + 1]] = [order[dragIndex + 1]!, order[dragIndex]!]
    dragIndex++
  }
  const nextRanks = Array<number>(ranks.length)
  order.forEach((card, rank) => {
    nextRanks[card] = rank
  })
  return {toRank: dragIndex, nextRanks}
}

// Source table: ranks[0..n-1], cardTops[n..2n-1], cardHeights[2n..3n-1], then fromRank (the dragged card's rank)
// and pointerY.
export function buildDragReorder(cardCount: number) {
  const circuit = new Circuit(3 * cardCount + 2)
  const ranks = Array.from({length: cardCount}, (_, card) => card)
  const cardTops = Array.from({length: cardCount}, (_, card) => cardCount + card)
  const cardHeights = Array.from({length: cardCount}, (_, card) => 2 * cardCount + card)
  const fromRank = 3 * cardCount
  const pointerY = 3 * cardCount + 1
  for (const rank of [...ranks, fromRank]) {
    circuit.assumeRange(asWire(rank), 0, cardCount - 1)
    circuit.assumeGrid(asWire(rank), 1)
  }
  for (const top of cardTops) {
    circuit.assumeRange(asWire(top), 0, positionMaximum)
    circuit.assumeGrid(asWire(top), 1 / 64)
  }
  for (const height of cardHeights) {
    circuit.assumeRange(asWire(height), 0, heightMaximum)
    circuit.assumeGrid(asWire(height), 1 / 64)
  }
  circuit.assumeRange(asWire(pointerY), -heightMaximum, positionMaximum)
  circuit.assumeGrid(asWire(pointerY), 1 / 64)

  const cards = ranks.map((rank, card) => {
    const before = emitCompare(circuit, asWire(rank), '<', asWire(fromRank))
    const after = emitCompare(circuit, asWire(rank), '>', asWire(fromRank))
    const midpoint = circuit.roundAffine([[asWire(cardTops[card]!), 1], [asWire(cardHeights[card]!), 0.5]])
    // passedUpward and passedDownward are 1 when the dragged card passes this card. The AND of two bits is
    // relu(a + b - 1).
    const passedUpward = circuit.reglu([], 1, [[before, 1], [emitCompare(circuit, asWire(pointerY), '<', midpoint), 1]], -1)
    const passedDownward = circuit.reglu([], 1, [[after, 1], [emitCompare(circuit, asWire(pointerY), '>', midpoint), 1]], -1)
    const isDragged = circuit.roundAffine([[before, -1], [after, -1]], 1)
    for (const bit of [passedUpward, passedDownward, isDragged]) circuit.assumeRange(bit, 0, 1)
    return {rank, passedUpward, passedDownward, isDragged}
  })

  // Midpoints never decrease along ranks, so the passed cards form one run next to the dragged card, and each
  // while loop's number of swaps is a count of bits.
  const passedUpwardCount = circuit.roundAffine(cards.map(card => [card.passedUpward, 1]))
  const passedDownwardCount = circuit.roundAffine(cards.map(card => [card.passedDownward, 1]))
  const rankShift = circuit.roundAffine([[passedDownwardCount, 1], [passedUpwardCount, -1]])
  circuit.assumeRange(rankShift, -(cardCount - 1), cardCount - 1)
  const toRank = circuit.roundAffine([[asWire(fromRank), 1], [rankShift, 1]])
  // A card passed upward moves one rank later, a card passed downward one rank earlier, and the dragged card
  // moves by the shift.
  const nextRanks = cards.map(card => {
    const nextRank = circuit.roundAffine([
      [asWire(card.rank), 1],
      [card.passedUpward, 1],
      [card.passedDownward, -1],
      [circuit.multiply(rankShift, card.isDragged), 1],
    ])
    circuit.assumeRange(nextRank, 0, cardCount - 1)
    return nextRank
  })
  return {circuit, ranks, cardTops, cardHeights, fromRank, pointerY, cards, toRank, nextRanks}
}
