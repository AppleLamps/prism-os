// Compares two layout results: positions, sizes and scroll offsets by largest absolute
// difference, and discrete results (line counts, wrap line indices, grid column counts)
// by exact equality.
import type {LayoutResult} from './tree.ts'

export type LayoutDifference = {
  maxDrift: number
  worst: string
  discreteMismatches: string[]
  continuousCompared: number
  discreteCompared: number
}

export function compareLayouts(expected: LayoutResult, actual: LayoutResult): LayoutDifference {
  const difference: LayoutDifference = {maxDrift: 0, worst: '', discreteMismatches: [], continuousCompared: 0, discreteCompared: 0}
  const continuous = (label: string, expectedValue: number, actualValue: number | undefined) => {
    difference.continuousCompared++
    const drift = actualValue === undefined || Number.isNaN(actualValue) ? Number.POSITIVE_INFINITY : Math.abs(expectedValue - actualValue)
    if (drift > difference.maxDrift) {
      difference.maxDrift = drift
      difference.worst = `${label}: expected ${expectedValue}, got ${actualValue}`
    }
  }
  const discrete = (label: string, expectedValue: number, actualValue: number | undefined) => {
    difference.discreteCompared++
    if (expectedValue !== actualValue) difference.discreteMismatches.push(`${label}: expected ${expectedValue}, got ${actualValue}`)
  }
  for (const [name, rect] of expected.rects) {
    const other = actual.rects.get(name)
    continuous(`${name}.x`, rect.x, other?.x)
    continuous(`${name}.y`, rect.y, other?.y)
    continuous(`${name}.width`, rect.width, other?.width)
    continuous(`${name}.height`, rect.height, other?.height)
  }
  for (const [name, value] of expected.scroll) continuous(`${name}.scroll`, value, actual.scroll.get(name))
  for (const [name, value] of expected.lines) discrete(`${name}.lines`, value, actual.lines.get(name))
  for (const [name, value] of expected.gridColumns) discrete(`${name}.columns`, value, actual.gridColumns.get(name))
  for (const [name, list] of expected.wrapLines) {
    const other = actual.wrapLines.get(name)
    list.forEach((value, index) => discrete(`${name}.line[${index}]`, value, other?.[index]))
  }
  return difference
}
