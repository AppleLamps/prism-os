// The first and the last hit as two counts: indexOf and lastIndexOf of the same hit bits from one pass of running
// totals, e.g. the first and the last position of a text whose nesting depth is at most the depth at a bracket.
//
// JS:
//   let total = 0
//   const hitsThrough = hits.map(hit => total += hit)                 // running totals of the hit bits
//   const firstHit = hitsThrough.filter(count => count < 1).length    // hits.indexOf(1), or hits.length when nothing is hit
//   const lastHit = hitsThrough.filter(count => count < total).length // hits.lastIndexOf(1), or 0 when nothing is hit
//
// [hitsThrough[item] < 1] and [hitsThrough[item] < total] each read 1...1 0...0 along the items, so each count of 1s is
// an index, as in count-instead-of-search.ts.
import {Circuit, emitCompare, emitFirstActive, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix} from '../../../../../../src/runtime/prefix-networks.ts'

export function firstAndLastHitReference(hits: ArrayLike<number>) {
  let total = 0
  const hitsThrough = Array.from(hits, hit => total += hit)
  return {
    firstHit: hitsThrough.filter(count => count < 1).length,
    lastHit: hitsThrough.filter(count => count < total).length,
    total,
  }
}

// 'chain' adds the hits in the loop's order, 'brent-kung' with a prefix network, and 'two trees' is what the counts
// replace: one emitFirstActive tree from each end, each with a sum that turns its one-hot into an index.
export type FirstAndLastHitForm = 'chain' | 'brent-kung' | 'two trees'

// Source table: one cell per item, which holds 0 or 1. Host contract: every hit is an exact bit. With
// `declareGrid: false` the bits have no declared grid, which shows what the comparisons cost then: emitCompare can't
// prove that the totals are whole numbers, so every comparison with the total is a sign cascade.
export function buildFirstAndLastHit(itemCount: number, form: FirstAndLastHitForm, options: {declareGrid?: boolean, lastHit?: boolean} = {}) {
  const circuit = new Circuit(itemCount)
  const hits = Array.from({length: itemCount}, (_, item) => {
    const hit = circuit.source(item)
    circuit.assumeBit(hit)
    if (options.declareGrid !== false) circuit.assumeGrid(hit, 1)
    return hit
  })
  const withLastHit = options.lastHit !== false
  if (form === 'two trees') {
    // Each tree gives a one-hot, or all zeros when nothing is hit, and Σ item × oneHot[item] is the hit's index.
    const always = circuit.constant(1)
    const indexOf = (oneHot: readonly Wire[]) => circuit.roundAffine(oneHot.map((bit, item) => [bit, item] as const))
    const firstHit = indexOf(emitFirstActive(circuit, always, hits))
    const lastHit = withLastHit ? indexOf(emitFirstActive(circuit, always, hits.toReversed()).toReversed()) : undefined
    return {circuit, hits, firstHit, lastHit, total: undefined}
  }
  // JS: hitsThrough = hits.map(hit => total += hit)
  const add = (earlier: Wire, later: Wire) => circuit.roundAffine([[earlier, 1], [later, 1]])
  let hitsThrough: Wire[]
  if (form === 'chain') {
    hitsThrough = [hits[0]!]
    for (let item = 1; item < itemCount; item++) hitsThrough.push(add(hitsThrough[item - 1]!, hits[item]!))
  } else {
    hitsThrough = brentKungPrefix(hits, add)
  }
  const total = hitsThrough[itemCount - 1]!
  // JS: hitsThrough.filter(count => count < 1).length. For a whole number count, [count < 1] is relu(1 − count).
  const firstHit = circuit.roundAffine(hitsThrough.map(count => [circuit.reglu([], 1, [[count, -1]], 1), 1] as const))
  // JS: hitsThrough.filter(count => count < total).length
  const lastHit = withLastHit ? circuit.roundAffine(hitsThrough.map(count => [emitCompare(circuit, count, '<', total), 1] as const)) : undefined
  return {circuit, hits, firstHit, lastHit, total}
}
