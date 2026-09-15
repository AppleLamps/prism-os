import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads, validateOneHotGroups} from '../../../../../../numeric-ui-core.ts'
import {buildCompaction, compactionReference, priceMaximum, type CompactionForm, type Slot} from './compaction-into-slots.ts'
import {createBothEvaluators, createRandom, measureProgram, randomInteger} from './kit.ts'

const forms: CompactionForm[] = ['one-hot', 'binary search']

type Filter = {minPrice: number, maxPrice: number, prices: number[]}

// Prices of 0 and 1 with minPrice 1 and maxPrice 2 make visibility a chosen pattern of bits.
function filtersFor(random: () => number, itemCount: number, slotCount: number): Filter[] {
  const fromBits = (bits: number[]): Filter => ({minPrice: 1, maxPrice: 2, prices: bits})
  const bitsWhere = (visible: (item: number) => boolean) => Array.from({length: itemCount}, (_, item) => visible(item) ? 1 : 0)
  const filters = [
    fromBits(bitsWhere(() => false)),
    fromBits(bitsWhere(() => true)),
    fromBits(bitsWhere(item => item === 0)),
    fromBits(bitsWhere(item => item === itemCount - 1)),
    fromBits(bitsWhere(item => item % 2 === 1)),
  ]
  // Exactly slotCount - 1, slotCount and slotCount + 1 visible items, all at the end of the list.
  for (const visibleCount of [slotCount - 1, slotCount, slotCount + 1]) filters.push(fromBits(bitsWhere(item => item >= itemCount - visibleCount)))
  for (const density of [0.001, 0.01, 0.1, 0.3, 0.5, 0.9]) {
    for (let trial = 0; trial < 3; trial++) filters.push(fromBits(bitsWhere(() => random() < density)))
  }
  // Random prices with random ranges, including an empty range, an inverted one and the whole range.
  const randomPrices = () => Array.from({length: itemCount}, () => randomInteger(random, 0, priceMaximum))
  filters.push({minPrice: 500, maxPrice: 500, prices: randomPrices()})
  filters.push({minPrice: 900, maxPrice: 100, prices: randomPrices()})
  filters.push({minPrice: 0, maxPrice: priceMaximum, prices: randomPrices()})
  for (let trial = 0; trial < 8; trial++) {
    const minPrice = randomInteger(random, 0, priceMaximum)
    filters.push({minPrice, maxPrice: randomInteger(random, minPrice, priceMaximum), prices: randomPrices()})
  }
  return filters
}

// The outputs as slots, with an absent slot's item as -1, like the reference.
function slotsFrom(outputs: readonly number[], slotCount: number): Slot[] {
  return Array.from({length: slotCount}, (_, slot) => {
    const present = outputs[3 * slot]!
    return {present, item: present === 1 ? outputs[3 * slot + 1]! : -1, price: outputs[3 * slot + 2]!}
  })
}

describe('compaction into K DOM slots', () => {
  test('both forms show the items of the loop that stops once every slot is filled, in both evaluators', () => {
    const random = createRandom(21)
    let presentSlots = 0
    let absentSlots = 0
    for (const [itemCount, slotCount] of [[1, 1], [2, 3], [7, 4], [64, 8], [200, 20]] as const) {
      const builds = forms.map(form => buildCompaction(itemCount, slotCount, form))
      const evaluators = builds.map(built => createBothEvaluators(built.circuit, built.roots))
      for (const {minPrice, maxPrice, prices} of filtersFor(random, itemCount, slotCount)) {
        const expected = compactionReference(prices, minPrice, maxPrice, slotCount)
        const source = Float32Array.from([minPrice, maxPrice, ...prices])
        builds.forEach((built, form) => {
          const {outputs, values} = evaluators[form]!(source)
          expect(slotsFrom(outputs, slotCount)).toEqual(expected)
          validateOneHotGroups(built.circuit, values)
          validateIndexReads(built.circuit, values)
          validateGrids(built.circuit, values)
        })
        for (const slot of expected) {
          if (slot.present === 1) presentSlots++
          else absentSlots++
        }
      }
    }
    expect(presentSlots).toBeGreaterThan(400)
    expect(absentSlots).toBeGreaterThan(400)
  })

  test('numbers quoted in the doc', () => {
    const visible = [0, 1, 1, 0, 1, 0, 1, 1]
    const source = Float32Array.from([1, 2, ...visible])
    const expected = compactionReference(visible, 1, 2, 4)
    expect(expected.map(slot => slot.item)).toEqual([1, 2, 4, 6])
    for (const form of forms) {
      const built = buildCompaction(8, 4, form)
      const values = built.circuit.evaluateReference(source)
      expect(built.visibleThrough.map(wire => values[wire])).toEqual([0, 1, 2, 2, 3, 3, 4, 5])
      expect(slotsFrom(built.roots.map(wire => values[wire]!), 4)).toEqual(expected)
    }
    // The binary search for DOM slot 2 reads the counts at 7 (while building, since position starts at 0), 3, 5 and 4.
    const search = buildCompaction(8, 4, 'binary search')
    const values = search.circuit.evaluateReference(source)
    const steps = search.slots[2]!.steps
    expect(steps.map(step => values[step.count])).toEqual([5, 2, 3, 3])
    expect(steps.map(step => values[step.position])).toEqual([0, 4, 4, 4])
    const readAt = steps.map((_, index) => (index === 0 ? 0 : values[steps[index - 1]!.position]!) + 2 ** (steps.length - 1 - index) - 1)
    expect(readAt).toEqual([7, 3, 5, 4])
  })

  test('sizes quoted in the doc', () => {
    const oneHot = buildCompaction(1000, 20, 'one-hot')
    expect(measureProgram(oneHot.circuit, oneHot.visibleThrough)).toMatchObject({liveOperations: 6984, layers: 20})
    expect(measureProgram(oneHot.circuit, oneHot.roots)).toMatchObject({liveOperations: 47_044, layers: 24, gatherReads: 20})
    const search = buildCompaction(1000, 20, 'binary search')
    expect(measureProgram(search.circuit, search.roots)).toMatchObject({liveOperations: 7824, layers: 57, indexReads: 200})
    const largeSearch = buildCompaction(10_000, 24, 'binary search')
    expect(measureProgram(largeSearch.circuit, largeSearch.roots)).toMatchObject({liveOperations: 71_373, layers: 80})
  })
})
