// Grow with min and max, e.g. a row whose children share the leftover width equally, where each
// child stays between its own low (its content's fit width) and its own high (its maximum width),
// and the width a clamped child can't take goes to the others. In the final layout every child's
// width is clamp(level, low, high) for one shared level. Finding that level is called water filling.
//
// Host contract: the container width is a whole number of pixels in 0..16,384, every low and high is
// a whole number of pixels in 0..4,096, every child's low is at most its high, and there are at most
// 64 children, so every sum below is an integer smaller than 2^23.
import {Circuit, invariant, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitIntegerAtLeastZero} from './kit.ts'

// JS reference, a plain loop that stops early. total(level) = Σ clamp(level, low, high) never
// decreases as the level rises and is linear between neighboring breakpoints (the lows and highs),
// so walk the sorted breakpoints until the total reaches the container width, then interpolate.
export function waterFillReference(lows: readonly number[], highs: readonly number[], containerWidth: number): number[] {
  invariant(lows.length >= 1 && lows.length === highs.length, 'water filling needs matching lows and highs')
  const clampToChild = (level: number, child: number) => Math.min(Math.max(level, lows[child]!), highs[child]!)
  const total = (level: number) => lows.reduce((sum, _, child) => sum + clampToChild(level, child), 0)
  const breakpoints = [...lows, ...highs].sort((left, right) => left - right)
  if (containerWidth <= total(breakpoints[0]!)) return [...lows]
  for (let index = 1; index < breakpoints.length; index++) {
    const left = breakpoints[index - 1]!
    const right = breakpoints[index]!
    const totalAtRight = total(right)
    if (totalAtRight < containerWidth) continue
    const totalAtLeft = total(left)
    const level = left + (containerWidth - totalAtLeft) * (right - left) / (totalAtRight - totalAtLeft)
    return lows.map((_, child) => clampToChild(level, child))
  }
  return [...highs]
}

// Source layout: cell 0 is the container width, cells 1..n are the lows, cells n+1..2n are the highs.
export function buildWaterFill(childCount: number) {
  invariant(childCount >= 1 && childCount <= 64, 'this example handles 1 to 64 children')
  const circuit = new Circuit(1 + 2 * childCount)
  const containerWidth = 0
  const lows = Array.from({length: childCount}, (_, child) => 1 + child)
  const highs = Array.from({length: childCount}, (_, child) => 1 + childCount + child)
  circuit.assumeRange(containerWidth, 0, 16_384)
  for (const wire of [...lows, ...highs]) circuit.assumeRange(wire, 0, 4_096)

  // excess = the width left over after every child gets its low.
  const excess = circuit.roundAffine([[containerWidth, 1], ...lows.map(low => [low, -1] as const)])

  // relu(a - b) for two breakpoints. relu(b - a) = relu(a - b) - (a - b), so each pair of
  // breakpoints needs only one ReLU.
  const sharedRelus = new Map<string, Wire>()
  const reluDifference = (a: Wire, b: Wire): [Wire, number][] => {
    const first = Math.min(a, b)
    const second = Math.max(a, b)
    const key = `${first},${second}`
    let relu = sharedRelus.get(key)
    if (relu === undefined) {
      relu = circuit.reglu([], 1, [[first, 1], [second, -1]], 0)
      sharedRelus.set(key, relu)
    }
    return a === first ? [[relu, 1]] : [[relu, 1], [a, 1], [b, -1]]
  }

  // filledAt(point) = Σ_k relu(point - low_k) - relu(point - high_k): how much the children add on
  // top of their lows when the level is at `point`. Child i's own terms are known while building:
  // relu(low_i - low_i) = relu(low_i - high_i) = 0, and relu(high_i - low_i) = high_i - low_i.
  // Every partial sum is an integer below 2^24, so the order of the additions doesn't matter.
  const filledAt = (point: Wire, child: number, pointIsHigh: boolean): Wire => {
    const terms: [Wire, number][] = []
    for (let other = 0; other < childCount; other++) {
      if (other === child) {
        if (pointIsHigh) terms.push([highs[child]!, 1], [lows[child]!, -1])
        continue
      }
      terms.push(...reluDifference(point, lows[other]!))
      for (const [wire, coefficient] of reluDifference(point, highs[other]!)) terms.push([wire, -coefficient])
    }
    return circuit.affine(terms)
  }

  // atLow[i] = [filledAt(low_i) >= excess]: the level stays at or below child i's low, so the child keeps its low.
  const atLow = lows.map((low, child) => emitIntegerAtLeastZero(circuit, [[filledAt(low, child, false), 1], [excess, -1]], 0))
  // atHigh[i] = [filledAt(high_i) <= excess] AND NOT atLow[i]: the level reaches child i's high.
  const atHigh = highs.map((high, child) => {
    const reachesHigh = emitIntegerAtLeastZero(circuit, [[excess, 1], [filledAt(high, child, true), -1]], 0)
    const bit = circuit.reglu([], 1, [[reachesHigh, 1], [atLow[child]!, -1]], 0) // a AND NOT b = relu(a - b)
    circuit.assumeRange(bit, 0, 1)
    return bit
  })
  // free[i] = 1 when child i ends strictly between its low and its high, at the level.
  const free = lows.map((_, child) => {
    const bit = circuit.roundAffine([[atLow[child]!, -1], [atHigh[child]!, -1]], 1)
    circuit.assumeRange(bit, 0, 1)
    return bit
  })

  // 1 / freeCount, read through the one-hot of the count with constant coefficients. Exactly one
  // term is nonzero, so the sum is exactly Math.fround(1 / count). A count of 0 reads 0.
  const freeCount = circuit.roundAffine(free.map(bit => [bit, 1] as const))
  circuit.assumeRange(freeCount, 0, childCount)
  const atLeastCount = Array.from({length: childCount}, (_, index) => emitIntegerAtLeastZero(circuit, [[freeCount, 1]], -(index + 1)))
  const reciprocal = circuit.roundAffine(atLeastCount.map((bit, index) => {
    const isCount = index === childCount - 1 ? bit : circuit.roundAffine([[bit, 1], [atLeastCount[index + 1]!, -1]])
    return [isCount, Math.fround(1 / (index + 1))] as const
  }))
  circuit.assumeRange(reciprocal, 0, 1)

  // level × freeCount = excess - Σ atHigh[i] (high_i - low_i) + Σ free[i] low_i, an integer.
  const raisedToHigh = highs.map((high, child) => {
    const span = circuit.roundAffine([[high, 1], [lows[child]!, -1]])
    circuit.assumeRange(span, 0, 4_096)
    return circuit.multiply(atHigh[child]!, span)
  })
  const numerator = circuit.roundAffine([
    [excess, 1],
    ...raisedToHigh.map(product => [product, -1] as const),
    ...lows.map((low, child) => [circuit.multiply(free[child]!, low), 1] as const),
  ])
  const level = circuit.multiply(numerator, reciprocal)

  // size[i] = low_i + atHigh[i] (high_i - low_i) + free[i] relu(level - low_i)
  const sizes = lows.map((low, child) => {
    const share = circuit.reglu([[free[child]!, 1]], 0, [[level, 1], [low, -1]], 0)
    return circuit.roundAffine([[low, 1], [raisedToHigh[child]!, 1], [share, 1]])
  })
  return {circuit, containerWidth, lows, highs, atLow, atHigh, free, level, sizes}
}
