// The first hit among overlapping items, e.g. the frontmost window under a press.
//
// JS:  for (let item = 0; item < itemCount; item++) if (hit[item] === 1) return item
//
// The hit bits aren't sorted (e.g. 0 1 0 1 1), so counting them doesn't give the first hit. Two
// ways around that: a tournament that routes a single 1 down to the first hit, or counting the
// earlier hits, which is a prefix sum over the bits.
import {Circuit, emitFirstActive, type Wire, asWire} from '../../../../../numeric-ui-core.ts'
import {emitRowTops} from './row-tops.ts'

export function firstHitReference(hits: ArrayLike<number>): number[] {
  const isFirstHit = Array<number>(hits.length).fill(0)
  for (let item = 0; item < hits.length; item++) {
    if (hits[item] === 1) {
      isFirstHit[item] = 1
      break
    }
  }
  return isFirstHit
}

export type FirstHitForm = 'tournament' | 'wide-counts' | 'brent-kung-counts'

// Source layout: cell i holds hit[i], exactly 0 or 1, with items in stacking order from the top.
// The last cell always holds 1 and gates the tournament.
export function buildFirstHit(itemCount: number, form: FirstHitForm) {
  const circuit = new Circuit(itemCount + 1)
  const hits = Array.from({length: itemCount}, (_, item) => circuit.source(item))
  const unit = itemCount
  for (const hit of hits) circuit.assumeRange(hit, 0, 1)
  circuit.assumeRange(asWire(unit), 1, 1)
  let isFirstHit: Wire[]
  if (form === 'tournament') {
    // Pairs are combined with max up a balanced tree, then the unit is routed down to the left-most
    // subtree that holds a hit.
    isFirstHit = emitFirstActive(circuit, asWire(unit), hits)
  } else {
    // hitsBefore[item] = hit[0] + ... + hit[item - 1], the same prefix sum as row tops.
    const hitsBefore = emitRowTops(circuit, hits, form === 'wide-counts' ? 'wide' : 'brent-kung')
    // relu(hit - hitsBefore) is 1 for a hit with no earlier hit and 0 for every other item:
    // a miss gives relu(0 - k) = 0, and a later hit gives relu(1 - k) = 0 because k >= 1.
    isFirstHit = hits.map((hit, item) => circuit.reglu([], 1, [[asWire(hit), 1], [hitsBefore[item]!, -1]], 0))
  }
  return {circuit, hits, unit, isFirstHit}
}
