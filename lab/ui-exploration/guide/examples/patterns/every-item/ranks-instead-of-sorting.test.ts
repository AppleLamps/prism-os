import {describe, expect, test} from 'bun:test'
import {validateGrids} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {createBothEvaluators, createRandom, measureProgram, randomInteger} from './kit.ts'
import {buildDragReorder, buildRanks, dragReorderReference, heightMaximum, keyMaximum, sortReference} from './ranks-instead-of-sorting.ts'

function shuffledCards(random: () => number, cardCount: number) {
  const order = Array.from({length: cardCount}, (_, card) => card)
  for (let index = cardCount - 1; index > 0; index--) {
    const swap = randomInteger(random, 0, index)
    ;[order[index], order[swap]] = [order[swap]!, order[index]!]
  }
  return order
}

describe('ranks instead of sorting', () => {
  test('ranks and item tops equal a stable sort on tied, extreme and random keys, in both evaluators', () => {
    const random = createRandom(11)
    let trials = 0
    for (const itemCount of [1, 2, 5, 16, 33]) {
      const built = buildRanks(itemCount)
      const evaluate = createBothEvaluators(built.circuit, [...built.ranks, ...built.itemTops])
      for (let trial = 0; trial < 45; trial++) {
        // A third of the trials draw keys from 4 values, so many keys tie, a third use only 0 and 65,535, and the
        // rest draw from the whole range.
        const keys = Array.from({length: itemCount}, () => trial % 3 === 0
          ? randomInteger(random, 0, 3)
          : trial % 3 === 1 ? (random() < 0.5 ? 0 : keyMaximum) : randomInteger(random, 0, keyMaximum))
        const heights = Array.from({length: itemCount}, () => randomInteger(random, 0, heightMaximum * 4) / 4)
        const {outputs, values} = evaluate(Float32Array.from([...keys, ...heights]))
        const expected = sortReference(keys, heights)
        expect(outputs).toEqual([...expected.ranks, ...expected.itemTops])
        if (trial % 9 === 0) validateGrids(built.circuit, values)
        trials++
      }
    }
    expect(trials).toBe(225)
  })

  test('moving one card updates every rank like the draggable-cards while loops, in both evaluators', () => {
    const random = createRandom(12)
    let movedUp = 0
    let movedDown = 0
    let stayed = 0
    for (const cardCount of [1, 2, 3, 9, 40]) {
      const built = buildDragReorder(cardCount)
      const evaluate = createBothEvaluators(built.circuit, [...built.nextRanks, built.toRank])
      const trialCount = cardCount >= 40 ? 4 : 12
      for (let trial = 0; trial < trialCount; trial++) {
        const order = shuffledCards(random, cardCount)
        const ranks = Array<number>(cardCount)
        order.forEach((card, rank) => {
          ranks[card] = rank
        })
        // Heights on the 1/64 px grid, some of them 0, laid out as last frame's stack in rank order.
        const cardHeights = Array.from({length: cardCount}, () => random() < 0.15 ? 0 : randomInteger(random, 1, 300 * 64) / 64)
        const cardTops = Array<number>(cardCount)
        let stackBottom = 50
        for (const card of order) {
          cardTops[card] = stackBottom
          stackBottom += cardHeights[card]!
        }
        // Pointers on the 1/64 px grid right at every card's midpoint and one step to either side, above and below
        // the stack, and random.
        const pointers = [-20, stackBottom + 20]
        for (let card = 0; card < cardCount; card++) {
          const midpoint = cardTops[card]! + cardHeights[card]! / 2
          const below = Math.floor(midpoint * 64) / 64
          const above = Math.ceil(midpoint * 64) / 64
          pointers.push(below - 1 / 64, below, above, above + 1 / 64)
        }
        for (let pointer = 0; pointer < 6; pointer++) pointers.push(randomInteger(random, -64 * 64, (stackBottom + 64) * 64) / 64)
        const fromRanks = cardCount <= 9 ? order.map((_, rank) => rank) : [0, cardCount - 1, randomInteger(random, 1, cardCount - 2), randomInteger(random, 1, cardCount - 2)]
        for (const fromRank of fromRanks) {
          for (const pointerY of pointers) {
            const {outputs, values} = evaluate(Float32Array.from([...ranks, ...cardTops, ...cardHeights, fromRank, pointerY]))
            const expected = dragReorderReference({ranks, cardTops, cardHeights, fromRank, pointerY})
            expect(outputs).toEqual([...expected.nextRanks, expected.toRank])
            if (expected.toRank < fromRank) movedUp++
            else if (expected.toRank > fromRank) movedDown++
            else stayed++
            if (pointerY === pointers[0]) validateGrids(built.circuit, values)
          }
        }
      }
    }
    expect(movedUp).toBeGreaterThan(1000)
    expect(movedDown).toBeGreaterThan(1000)
    expect(stayed).toBeGreaterThan(1000)
  })

  test('numbers quoted in the doc', () => {
    const ranks = buildRanks(4)
    const rankValues = ranks.circuit.evaluateReference(Float32Array.from([30, 10, 30, 20, 0, 0, 0, 0]))
    expect(ranks.ranks.map(wire => rankValues[wire])).toEqual([2, 0, 3, 1])
    // Row `item` of the diagram: does `other` come before `item`?
    const comesBefore = (other: number, item: number) => other < item
      ? rankValues[ranks.earlierFirst[other]![item]!]!
      : 1 - rankValues[ranks.earlierFirst[item]![other]!]!
    const matrix = [0, 1, 2, 3].map(item => [0, 1, 2, 3].filter(other => other !== item).map(other => comesBefore(other, item)))
    expect(matrix).toEqual([[1, 0, 1], [0, 0, 0], [1, 1, 1], [0, 1, 0]])

    // Cards A to E ranked 0 to 4, each 40 px tall from 0 px, with D (rank 3) dragged and the pointer at 50 px.
    const drag = buildDragReorder(5)
    const dragValues = drag.circuit.evaluateReference(Float32Array.from([0, 1, 2, 3, 4, 0, 40, 80, 120, 160, 40, 40, 40, 40, 40, 3, 50]))
    expect(drag.cards.map(card => dragValues[card.passedUpward])).toEqual([0, 1, 1, 0, 0])
    expect(dragValues[drag.toRank]).toBe(1)
    expect(drag.nextRanks.map(wire => dragValues[wire])).toEqual([0, 2, 3, 1, 4])
  })

  test('sizes quoted in the doc', () => {
    const ranks64 = buildRanks(64)
    expect(measureProgram(ranks64.circuit, ranks64.ranks)).toMatchObject({liveOperations: 4096, layers: 3})
    expect(measureProgram(ranks64.circuit, [...ranks64.ranks, ...ranks64.itemTops])).toMatchObject({liveOperations: 8192, layers: 4})
    // Every comparison is an integer bit, 2 operations per pair, and none is a sign cascade.
    expect(ranks64.circuit.roundingPoints().filter(point => point.kind === 'integer bit').length).toBe(4032)
    expect(ranks64.circuit.roundingPoints().length).toBe(4032)
    const ranks128 = buildRanks(128)
    expect(measureProgram(ranks128.circuit, ranks128.ranks)).toMatchObject({liveOperations: 16_384, layers: 3})
    for (const [cardCount, liveOperations] of [[100, 1404], [1000, 14_004]] as const) {
      const drag = buildDragReorder(cardCount)
      expect(measureProgram(drag.circuit, [...drag.nextRanks, drag.toRank])).toMatchObject({liveOperations, layers: 8})
    }
  })
})
