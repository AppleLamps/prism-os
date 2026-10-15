import {describe, expect, test} from 'bun:test'
import {validateGrids, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {buildFirstAndLastHit, firstAndLastHitReference, type FirstAndLastHitForm} from './first-and-last-hit.ts'
import {createBothEvaluators, createRandom, measureProgram} from './kit.ts'

const forms: FirstAndLastHitForm[] = ['chain', 'brent-kung', 'two trees']

// Hit bits of every density, and the lists that a count gets wrong first: nothing hit, everything hit, and one hit at
// either end.
function hitLists(itemCount: number, random: () => number, randomLists: number): number[][] {
  const only = (item: number) => Array.from({length: itemCount}, (_, index) => Number(index === item))
  const lists = [Array<number>(itemCount).fill(0), Array<number>(itemCount).fill(1), only(0), only(itemCount - 1)]
  for (let list = 0; list < randomLists; list++) {
    const density = [0.02, 0.1, 0.5, 0.9][list % 4]!
    lists.push(Array.from({length: itemCount}, () => Number(random() < density)))
  }
  return lists
}

describe('the first and the last hit as two counts', () => {
  test('the JavaScript of the pattern gives indexOf and lastIndexOf, and the item count and 0 when nothing is hit', () => {
    const random = createRandom(57)
    let withHits = 0
    for (const itemCount of [1, 2, 7, 40]) {
      for (const hits of hitLists(itemCount, random, 400)) {
        const {firstHit, lastHit, total} = firstAndLastHitReference(hits)
        if (hits.includes(1)) {
          expect([firstHit, lastHit]).toEqual([hits.indexOf(1), hits.lastIndexOf(1)])
          withHits++
        } else {
          expect([firstHit, lastHit, total]).toEqual([itemCount, 0, 0])
        }
      }
    }
    expect(withHits).toBeGreaterThan(900)
  })

  test('every form gives the loop\'s indexes, in both evaluators, with every declared grid holding', () => {
    const random = createRandom(58)
    let checks = 0
    for (const itemCount of [1, 2, 5, 33, 100]) {
      for (const form of forms) {
        const built = buildFirstAndLastHit(itemCount, form)
        const roots: Wire[] = [built.firstHit, built.lastHit!]
        const evaluate = createBothEvaluators(built.circuit, roots)
        for (const hits of hitLists(itemCount, random, 40)) {
          const {roots: [firstHit, lastHit], everyWire} = evaluate(Float32Array.from(hits))
          validateGrids(built.circuit, everyWire)
          const expected = firstAndLastHitReference(hits)
          // When nothing is hit, each tree's one-hot is all zeros, so its index is 0, where the count is the item count.
          const expectedFirst = form === 'two trees' && expected.total === 0 ? 0 : expected.firstHit
          expect([form, itemCount, firstHit, lastHit]).toEqual([form, itemCount, expectedFirst, expected.lastHit])
          checks++
        }
      }
    }
    expect(checks).toBeGreaterThan(600)
  })

  test('sizes quoted in the pattern, at 513 items', () => {
    const sizeOf = (form: FirstAndLastHitForm, options: {declareGrid?: boolean, lastHit?: boolean} = {}) => {
      const built = buildFirstAndLastHit(513, form, options)
      const {operations, layers} = measureProgram(built.circuit, built.lastHit === undefined ? [built.firstHit] : [built.firstHit, built.lastHit])
      return `${operations} operations in ${layers} layers`
    }
    expect({
      chain: sizeOf('chain'),
      brentKung: sizeOf('brent-kung'),
      twoTrees: sizeOf('two trees'),
      firstHitAloneBrentKung: sizeOf('brent-kung', {lastHit: false}),
      firstHitAloneOneTree: sizeOf('two trees', {lastHit: false}),
    }).toEqual({
      chain: '2052 operations in 515 layers',
      brentKung: '2554 operations in 19 layers',
      twoTrees: '5125 operations in 51 layers',
      firstHitAloneBrentKung: '1528 operations in 18 layers',
      firstHitAloneOneTree: '2563 operations in 51 layers',
    })
  })

  test('every comparison with the total is an integer bit when the hits have a grid, and a sign cascade when they have none', () => {
    const kindsOf = (declareGrid: boolean) => {
      const built = buildFirstAndLastHit(513, 'brent-kung', {declareGrid})
      const kinds: {[kind: string]: number} = {}
      for (const point of built.circuit.roundingPoints()) kinds[point.kind] = (kinds[point.kind] ?? 0) + 1
      const {operations, layers} = measureProgram(built.circuit, [built.firstHit, built.lastHit!])
      return {kinds, size: `${operations} operations in ${layers} layers`}
    }
    const withGrid = kindsOf(true)
    const withoutGrid = kindsOf(false)
    expect(withGrid.kinds['sign cascade']).toBeUndefined()
    expect(withGrid.kinds['integer bit']).toBeGreaterThan(0)
    expect(withoutGrid.kinds['integer bit']).toBeUndefined()
    expect(withoutGrid.kinds['sign cascade']).toBeGreaterThan(0)
    expect([withGrid.size, withoutGrid.size]).toEqual(['2554 operations in 19 layers', '9722 operations in 32 layers'])
  })
})
