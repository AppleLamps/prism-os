// Exact bits from comparisons, used by both card row versions. These are the constructions of
// lab/ui-exploration/gallery/kit.ts (emitAll and the integer ramps); the comparisons section of the
// guide explains why they give exact 0/1 results.
import {Circuit, type Terms, type Wire} from '../../../../../numeric-ui-core.ts'

// A check on a difference that the circuit keeps as its own value (a roundAffine), e.g. pointerX - cardLeft >= 0.
export type Check = {difference: Wire, strict: boolean}
export const atLeastZero = (difference: Wire): Check => ({difference, strict: false})
export const aboveZero = (difference: Wire): Check => ({difference, strict: true})

// 1 when every check holds, else 0. A failing check produces a failure score of at least 0.5, for any
// difference that is 0 or at least 2^-41 in magnitude, and one ReLU turns "every failure score is 0" into 1.
export function emitAllChecks(circuit: Circuit, checks: readonly Check[]): Wire {
  const failureTerms = checks.map(({difference, strict}): [Wire, number] => {
    // `difference >= 0` fails when difference < 0; `difference > 0` also fails when difference is exactly 0.
    const failure = circuit.reglu([], 1, [[difference, -(2 ** 40)]], strict ? 0.5 : 0)
    return [failure, -2]
  })
  const allHold = circuit.reglu([], 1, failureTerms, 1)
  circuit.assumeRange(allHold, 0, 1)
  return circuit.boolean(allHold)
}

// [value = 0] for an integer-valued sum of terms below 2^23 in magnitude, as relu(v + 1) - 2 relu(v) + relu(v - 1).
export function emitIntegerIsZero(circuit: Circuit, terms: Terms): Wire {
  const bit = circuit.affine([
    [circuit.reglu([], 1, terms, 1), 1],
    [circuit.reglu([], 1, terms, 0), -2],
    [circuit.reglu([], 1, terms, -1), 1],
  ])
  circuit.assumeRange(bit, 0, 1)
  return bit
}
