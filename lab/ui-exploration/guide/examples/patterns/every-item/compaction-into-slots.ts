// Compaction into K DOM slots: a filtered list shows its first K visible items in K reusable DOM nodes. Every
// item's filter test runs in the same layers, a prefix sum counts the visible items through each item, and DOM slot k
// shows the item where that count first reaches k + 1. Two ways to route items into slots: a one-hot per slot
// from neighbor differences, O(n × K) operations, or a binary search per slot with index reads, O(K log n)
// operations after the counts.
//
// Host contract: prices, minPrice and maxPrice are integers within 0..1,024.
import {Circuit, emitCompare, type Wire} from '../../../../../../numeric-ui-core.ts'

export const priceMaximum = 1024

export type CompactionForm = 'one-hot' | 'binary search'

// item is meaningful only while present is 1. An absent slot shows nothing, and its price is 0.
export type Slot = {present: number, item: number, price: number}

// JS: walk the items, and stop once every DOM slot is filled.
export function compactionReference(prices: readonly number[], minPrice: number, maxPrice: number, slotCount: number): Slot[] {
  const shownItems: number[] = []
  for (let item = 0; item < prices.length && shownItems.length < slotCount; item++) {
    if (prices[item]! >= minPrice && prices[item]! < maxPrice) shownItems.push(item)
  }
  return Array.from({length: slotCount}, (_, slot) => slot < shownItems.length
    ? {present: 1, item: shownItems[slot]!, price: prices[shownItems[slot]!]!}
    : {present: 0, item: -1, price: 0})
}

// steps holds the binary search's count reads and the position after each step, and is empty for the one-hot form.
export type SlotWires = {present: Wire, item: Wire, price: Wire, steps: {count: Wire, position: Wire}[]}

// Source table: [minPrice, maxPrice, prices[0], ..., prices[n - 1]].
export function buildCompaction(itemCount: number, slotCount: number, form: CompactionForm) {
  const circuit = new Circuit(2 + itemCount)
  const minPrice = 0
  const maxPrice = 1
  const prices = Array.from({length: itemCount}, (_, item) => 2 + item)
  for (const wire of [minPrice, maxPrice, ...prices]) {
    circuit.assumeRange(wire, 0, priceMaximum)
    circuit.assumeGrid(wire, 1)
  }

  // Every item's filter test, all in the same layers: [minPrice <= price && price < maxPrice].
  const visible = prices.map(price => {
    const bit = circuit.reglu([], 1, [[emitCompare(circuit, price, '>=', minPrice), 1], [emitCompare(circuit, price, '<', maxPrice), 1]], -1)
    circuit.assumeRange(bit, 0, 1)
    circuit.assumeGrid(bit, 1)
    return bit
  })
  const visibleThrough = emitPrefixCounts(circuit, visible)
  const slots = form === 'one-hot'
    ? routeByOneHots(circuit, visibleThrough, prices, slotCount)
    : routeByBinarySearch(circuit, visibleThrough, prices, slotCount)
  const roots = slots.flatMap(slot => [slot.present, slot.item, slot.price])
  return {circuit, minPrice, maxPrice, prices, visible, visibleThrough, slots, roots}
}

// visibleThrough[item] = visible[0] + ... + visible[item], from a Brent-Kung network: about 2n additions in about
// 2 log2 n layers. Every partial sum is an integer below 2^24, so any grouping gives the loop's exact counts.
export function emitPrefixCounts(circuit: Circuit, bits: readonly Wire[]): Wire[] {
  const through = [...bits]
  const count = bits.length
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) {
      through[index] = circuit.roundAffine([[through[index - span]!, 1], [through[index]!, 1]])
    }
  }
  for (span /= 4; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) {
      through[index] = circuit.roundAffine([[through[index - span]!, 1], [through[index]!, 1]])
    }
  }
  through.forEach((wire, index) => circuit.assumeRange(wire, 0, index + 1))
  return through
}

// [visibleThrough[item] <= k] reads 1...1 0...0 along items, and its neighbor differences mark the item where the
// count first passes k, i.e. the (k + 1)-th visible item. For an integer count, [count <= k] is
// relu(k + 1 - count) - relu(k - count), and consecutive k share a ReLU, so each item costs slotCount ReLUs.
// This is lists' routing.ts.
function routeByOneHots(circuit: Circuit, visibleThrough: readonly Wire[], prices: readonly Wire[], slotCount: number): SlotWires[] {
  const itemCount = visibleThrough.length
  // ramps[item][k] = relu(k + 1 - visibleThrough[item]). relu(0 - count) is always 0, so it needs no operation.
  const ramps = visibleThrough.map(count => Array.from({length: slotCount}, (_, k) => circuit.reglu([], 1, [[count, -1]], k + 1)))
  const atMost = (item: number, k: number): [Wire, number][] => k === 0
    ? [[ramps[item]![0]!, 1]]
    : [[ramps[item]![k]!, 1], [ramps[item]![k - 1]!, -1]]
  const negated = (terms: [Wire, number][]) => terms.map(([wire, coefficient]): [Wire, number] => [wire, -coefficient])
  return Array.from({length: slotCount}, (_, k) => {
    // isShown[item] = [visibleThrough[item - 1] <= k] - [visibleThrough[item] <= k], with 1 before the first item.
    const isShown = Array.from({length: itemCount}, (_, item) => {
      const bit = item === 0
        ? circuit.roundAffine(negated(atMost(0, k)), 1)
        : circuit.roundAffine([...atMost(item - 1, k), ...negated(atMost(item, k))])
      circuit.assumeRange(bit, 0, 1)
      return bit
    })
    circuit.assumeOneHot(isShown, true)
    const present = circuit.roundAffine(negated(atMost(itemCount - 1, k)), 1)
    circuit.assumeRange(present, 0, 1)
    const item = circuit.affine(isShown.map((bit, index) => [bit, index] as const))
    // A masked sum over the slot's one-hot, which the compiler lowers to one gather read.
    const price = circuit.affine(isShown.map((bit, index) => [circuit.multiply(bit, prices[index]!), 1] as const))
    return {present, item, price, steps: []}
  })
}

// The counts never decrease along items, so "how many items have visibleThrough <= k" is found one binary digit
// at a time: read the count at position + step - 1, and add step to position when that count is at most k.
// Reading past the last item clamps to the total count.
function routeByBinarySearch(circuit: Circuit, visibleThrough: readonly Wire[], prices: readonly Wire[], slotCount: number): SlotWires[] {
  const itemCount = visibleThrough.length
  const stepCount = Math.ceil(Math.log2(itemCount + 1))
  const visibleCount = visibleThrough[itemCount - 1]!
  return Array.from({length: slotCount}, (_, k) => {
    const slotIndex = circuit.affine([], k)
    const steps: {count: Wire, position: Wire}[] = []
    let position: Wire | undefined
    for (let step = 2 ** (stepCount - 1); step >= 1; step /= 2) {
      // The first read's index is a constant, so the builder picks that count while building.
      const count = circuit.indexReadAffine(position === undefined ? [] : [[position, 1]], step - 1, visibleThrough, 'clamp', 'clamp')
      // An index read gets no grid. The counts hold integers, so declare one, or emitCompare builds a sign cascade.
      circuit.assumeGrid(count, 1)
      const countAtMostK = emitCompare(circuit, count, '<=', slotIndex)
      position = circuit.roundAffine(position === undefined ? [[countAtMostK, step]] : [[position, 1], [countAtMostK, step]])
      circuit.assumeRange(position, 0, 2 ** stepCount - 1)
      steps.push({count, position})
    }
    const present = emitCompare(circuit, visibleCount, '>=', circuit.affine([], k + 1))
    // An absent slot's position lands past the last item, where the price read returns +0.
    const price = circuit.indexRead(position!, prices, {outOfRange: 'zero'})
    return {present, item: position!, price, steps}
  })
}
