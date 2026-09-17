// Small analysis helpers for report.ts: Pareto fronts, level thresholds for the
// tremor estimate, and markdown tables.

import {invariant} from '../../../src/runtime/numeric-ui-core.ts'

// Items that no other item beats or ties on every objective while beating on
// at least one. Lower is better for every objective.
export function paretoFront<T>(items: readonly T[], objectives: (item: T) => readonly number[]): T[] {
  const scores = items.map(objectives)
  return items.filter((_, index) => !scores.some((other, otherIndex) => {
    if (otherIndex === index) return false
    const mine = scores[index]!
    let strictlyBetter = false
    for (let objective = 0; objective < mine.length; objective++) {
      if (other[objective]! > mine[objective]!) return false
      if (other[objective]! < mine[objective]!) strictlyBetter = true
    }
    return strictlyBetter
  }))
}

// P(excursion >= level) for one segment's histogram.
export function shareAtLeast(histogram: ArrayLike<number>, level: number) {
  let total = 0
  let atLeast = 0
  for (let bin = 0; bin < histogram.length; bin++) {
    total += histogram[bin]!
    if (bin >= level) atLeast += histogram[bin]!
  }
  return total === 0 ? 0 : atLeast / total
}

// One whole-pixel threshold per boundary between neighboring segments. A user's
// counter for a level climbs when more than half of that user's presses reach
// the level, so a good threshold has fewer than half of the lower segment's
// presses reaching it and more than half of the upper segment's. Among such
// thresholds the one whose two shares sit most evenly around one half wins.
export function chooseLevelThresholds(histograms: readonly ArrayLike<number>[]) {
  const thresholds: number[] = []
  for (let boundary = 0; boundary + 1 < histograms.length; boundary++) {
    const lower = histograms[boundary]!
    const upper = histograms[boundary + 1]!
    const minimum = boundary === 0 ? 1 : thresholds[boundary - 1]! + 1
    let best = minimum
    let bestScore = Infinity
    for (let level = minimum; level < lower.length; level++) {
      const lowerShare = shareAtLeast(lower, level)
      const upperShare = shareAtLeast(upper, level)
      const separates = lowerShare < 0.5 && upperShare > 0.5
      const score = (separates ? 0 : 1) + Math.abs(lowerShare + upperShare - 1)
      if (score < bestScore) {
        bestScore = score
        best = level
      }
    }
    thresholds.push(best)
  }
  invariant(thresholds.every((threshold, index) => index === 0 || threshold > thresholds[index - 1]!), 'thresholds must increase')
  return thresholds
}

export function percent(value: number, digits = 2) {
  return (100 * value).toFixed(digits)
}

export function markdownRow(cells: readonly (string | number)[]) {
  return `| ${cells.map(cell => (typeof cell === 'number' ? cell.toLocaleString('en-US') : cell)).join(' | ')} |`
}

export function markdownHeader(cells: readonly string[]) {
  return [markdownRow(cells), markdownRow(cells.map(() => '---'))].join('\n')
}

// Binomial standard error of a rate measured over `count` trials.
export function standardError(rate: number, count: number) {
  return count === 0 ? 0 : Math.sqrt(rate * (1 - rate) / count)
}
