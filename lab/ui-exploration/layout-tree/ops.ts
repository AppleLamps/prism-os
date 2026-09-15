// Small circuit helpers for layout. Everything here lowers to affine, reglu and
// boolean atoms through the shared builder. Ordinary affines are used on purpose:
// constants fold into biases and small sums compose into their consumers.
import {Circuit, type Terms, type Wire} from '../../../numeric-ui-core.ts'

export function constantWire(circuit: Circuit, value: number): Wire {
  return circuit.affine([], value)
}

export function constantValue(circuit: Circuit, wire: Wire): number | undefined {
  return circuit.constants[wire]
}

export function relu(circuit: Circuit, terms: Terms, bias = 0): Wire {
  return circuit.reglu([], 1, terms, bias)
}

export function scaleTerms(terms: Terms, scale: number): [Wire, number][] {
  return terms.map(([wire, coefficient]) => [wire, coefficient * scale])
}

export function maxWire(circuit: Circuit, a: Wire, b: Wire): Wire {
  if (a === b) return a
  return circuit.affine([[b, 1], [relu(circuit, [[a, 1], [b, -1]]), 1]])
}

export function minWire(circuit: Circuit, a: Wire, b: Wire): Wire {
  if (a === b) return a
  return circuit.affine([[a, 1], [relu(circuit, [[a, 1], [b, -1]]), -1]])
}

// clamp(value, low, high) with constant bounds. Infinite bounds, and bounds that the
// value's declared range already satisfies, cost nothing.
export function clampConstant(circuit: Circuit, value: Wire, low: number, high: number): Wire {
  let result = value
  if (low > Number.NEGATIVE_INFINITY && circuit.ranges[result]!.minimum < low) {
    result = circuit.affine([[relu(circuit, [[result, 1]], -low), 1]], low)
  }
  if (high < Number.POSITIVE_INFINITY && circuit.ranges[result]!.maximum > high) {
    result = circuit.affine([[result, 1], [relu(circuit, [[result, 1]], -high), -1]])
  }
  return result
}

// Balanced tournament of maxWire. An empty list is 0.
export function maxOfList(circuit: Circuit, wires: readonly Wire[]): Wire {
  if (wires.length === 0) return constantWire(circuit, 0)
  let level = [...wires]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : maxWire(circuit, level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

export const comparisonScale = 256
// Values compared by atLeastZero must stay within this magnitude, so that the
// scaled score stays below 2^22 and FP32 keeps the plateau of the clamp exact.
export const comparisonMagnitude = 16_384

// Exact bit [terms + bias >= 0]. The difference is scaled by 256 and clamped to 0..1
// around 0.5, then the boolean atom rounds it: 4 atoms, 3 layers. A difference of 0
// gives 1. Any difference that FP32 computes as nonzero and at least 1/512 in size
// resolves correctly; tinier ones are treated as ties.
export function atLeastZero(circuit: Circuit, terms: Terms, bias: number): Wire {
  const difference = circuit.affine(terms, bias)
  const folded = constantValue(circuit, difference)
  if (folded !== undefined) return constantWire(circuit, folded >= 0 ? 1 : 0)
  const upper = relu(circuit, [[difference, comparisonScale]], 0.5)
  const lower = relu(circuit, [[difference, comparisonScale]], -0.5)
  const score = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(score, 0, 1)
  return circuit.boolean(score)
}

// Exact bit [value >= threshold] for an integer-valued affine form.
export function integerAtLeast(circuit: Circuit, terms: Terms, bias: number, threshold: number): Wire {
  const upper = relu(circuit, terms, bias - threshold + 1)
  const lower = relu(circuit, terms, bias - threshold)
  const bit = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// 1 / count for an integer count in 0..maxCount, with 1 / 0 read as 0. With r_k = relu(count - k),
// the bit [count == c] is r_(c-1) - 2 r_c + r_(c+1), exact for integers. Each bit is its own
// wire, so the sum over c of [count == c] / c has exactly one nonzero term and equals
// fround(1 / count) with no accumulated rounding. (A telescoping sum over threshold bits costs
// the same but accumulates relative error of a few 1e-6, which a large numerator turns into
// visible drift: 0.34 px across 64 growing children.)
export function reciprocalOfCount(circuit: Circuit, terms: Terms, bias: number, maxCount: number): Wire {
  const ramps = Array.from({length: maxCount + 1}, (_, offset) => relu(circuit, terms, bias - offset))
  const resultTerms: [Wire, number][] = []
  for (let count = 1; count <= maxCount; count++) {
    const bitTerms: [Wire, number][] = [[ramps[count - 1]!, 1], [ramps[count]!, -2]]
    if (count < maxCount) bitTerms.push([ramps[count + 1]!, 1])
    const equal = circuit.roundAffine(bitTerms)
    circuit.assumeRange(equal, 0, 1)
    resultTerms.push([equal, 1 / count])
  }
  const reciprocal = circuit.affine(resultTerms)
  circuit.assumeRange(reciprocal, 0, 1)
  return reciprocal
}

export type FillItem = {low: Wire, high: Wire | null}

// Water filling: sizes clamp(level, low_i, high_i) whose sum is sum(low) + excess.
// With excess <= 0 every size is its low; with excess >= sum(high - low), its high.
// A null high means no maximum.
//
// Instead of sorting breakpoints, the circuit evaluates the total at each child's own
// breakpoints. With E(p) = sum_k relu(p - low_k) - relu(p - high_k), which is the total
// at level p minus sum(low):
//   atLow_i  = [E(low_i) >= excess]     the level sits at or below low_i
//   atHigh_i = [E(high_i) <= excess] and not atLow_i
// Every remaining child is free and shares the leftover level equally, so the level is
// a sum of masked terms times 1 / (free count), read from the count's threshold bits.
// A decision that flips near a tie changes sizes continuously, so FP32 drift in the
// bits only causes drift in sizes.
export function waterFill(circuit: Circuit, items: readonly FillItem[], excessTerms: Terms, excessBias: number): Wire[] {
  if (items.length === 0) return []
  if (items.length === 1) {
    const item = items[0]!
    const raised = circuit.affine([[item.low, 1], [relu(circuit, excessTerms, excessBias), 1]])
    return [item.high === null ? raised : minWire(circuit, raised, item.high)]
  }
  const pairRelus = new Map<string, Wire>()
  // relu(a - b) as linear terms. relu(b - a) is derived as relu(a - b) - (a - b).
  const reluDifference = (a: Wire, b: Wire, scale: number): [Wire, number][] => {
    if (a === b) return []
    const first = Math.min(a, b)
    const second = Math.max(a, b)
    const key = `${first},${second}`
    let shared = pairRelus.get(key)
    if (shared === undefined) {
      shared = relu(circuit, [[first, 1], [second, -1]])
      pairRelus.set(key, shared)
    }
    return a === first ? [[shared, scale]] : [[shared, scale], [a, scale], [b, -scale]]
  }
  const excessAt = (point: Wire, ownIndex: number, pointIsHigh: boolean): [Wire, number][] => {
    const terms: [Wire, number][] = []
    items.forEach((item, index) => {
      if (index === ownIndex) {
        // relu(low_i - low_i) and relu(low_i - high_i) are 0; relu(high_i - low_i) is exact.
        if (pointIsHigh) terms.push([item.high!, 1], [item.low, -1])
        return
      }
      terms.push(...reluDifference(point, item.low, 1))
      if (item.high !== null) terms.push(...reluDifference(point, item.high, -1))
    })
    return terms
  }
  const negatedExcess = scaleTerms(excessTerms, -1)
  const atLow: Wire[] = []
  const atHigh: (Wire | null)[] = []
  items.forEach((item, index) => {
    atLow.push(atLeastZero(circuit, [...excessAt(item.low, index, false), ...negatedExcess], -excessBias))
    if (item.high === null) {
      atHigh.push(null)
      return
    }
    const rawHigh = atLeastZero(circuit, [...excessTerms, ...scaleTerms(excessAt(item.high, index, true), -1)], excessBias)
    const high = relu(circuit, [[rawHigh, 1], [atLow[index]!, -1]])
    circuit.assumeRange(high, 0, 1)
    atHigh.push(high)
  })
  const freeBits = items.map((_, index) => {
    const terms: [Wire, number][] = [[atLow[index]!, -1]]
    if (atHigh[index] !== null) terms.push([atHigh[index]!, -1])
    const bit = circuit.affine(terms, 1)
    circuit.assumeRange(bit, 0, 1)
    return bit
  })
  const countTerms: [Wire, number][] = []
  items.forEach((_, index) => {
    countTerms.push([atLow[index]!, -1])
    if (atHigh[index] !== null) countTerms.push([atHigh[index]!, -1])
  })
  const reciprocal = reciprocalOfCount(circuit, countTerms, items.length, items.length)
  // level * freeCount = excess - sum(atHigh * (high - low)) + sum(free * low)
  const spans = items.map((item, index) => {
    if (item.high === null) return null
    const span = circuit.affine([[item.high, 1], [item.low, -1]])
    circuit.assumeRange(span, 0, Number.POSITIVE_INFINITY)
    return circuit.multiply(span, atHigh[index]!)
  })
  const numeratorTerms: [Wire, number][] = scaleTerms(excessTerms, 1)
  items.forEach((item, index) => {
    if (spans[index] !== null) numeratorTerms.push([spans[index]!, -1])
    numeratorTerms.push([circuit.multiply(item.low, freeBits[index]!), 1])
  })
  const numerator = circuit.affine(numeratorTerms, excessBias)
  const level = circuit.multiply(numerator, reciprocal)
  return items.map((item, index) => {
    // free * relu(level - low) is one reglu; atLow children keep low, atHigh children reach high.
    const share = circuit.reglu([[freeBits[index]!, 1]], 0, [[level, 1], [item.low, -1]], 0)
    const terms: [Wire, number][] = [[item.low, 1], [share, 1]]
    if (spans[index] !== null) terms.push([spans[index]!, 1])
    return circuit.affine(terms)
  })
}
