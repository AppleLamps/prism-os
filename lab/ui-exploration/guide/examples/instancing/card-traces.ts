// Random card rows and pointer inputs, shared by instancing.test.ts and report.ts.
import {buildDuplicatedRow, createDuplicatedRunner, type PrefixLowering} from './cards-duplicated.ts'
import {layoutRowReference} from './cards-reference.ts'
import {evaluateStagedRow, type StagedRow} from './cards-staged.ts'
import type {Card, RowInput, RowOutputs} from './cards-types.ts'

export type Random = () => number

export function createRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export const integerBetween = (random: Random, minimum: number, maximum: number) => minimum + Math.floor(random() * (maximum - minimum + 1))

// With exact, sizes are integers, zoom is a multiple of 1/8, the gap and origin are integers, and pointers
// sit on quarter pixels. FP32 then holds every intermediate value exactly, so float64 JavaScript and the
// circuits compute the same numbers.
export function randomCards(random: Random, count: number, exact: boolean): Card[] {
  return Array.from({length: count}, () => exact
    ? {naturalWidth: integerBetween(random, 40, 400), naturalHeight: integerBetween(random, 40, 400)}
    : {naturalWidth: 40 + random() * 360, naturalHeight: 40 + random() * 360})
}

export function randomInput(random: Random, cards: readonly Card[], exact: boolean): RowInput {
  const zoom = exact ? integerBetween(random, 2, 16) / 8 : 0.25 + random() * 1.75
  const gap = exact ? integerBetween(random, -40, 40) : random() * 80 - 40
  const rowLeft = exact ? integerBetween(random, -200, 200) : random() * 400 - 200
  const rowTop = exact ? integerBetween(random, -200, 200) : random() * 400 - 200
  const input: RowInput = {zoom, gap, rowLeft, rowTop, pointerX: 0, pointerY: 0, pointerPresent: random() < 0.85}
  // Aim at one card's rectangle, often exactly at an edge, using the float64 layout.
  const layout = layoutRowReference(cards, input)
  const target = integerBetween(random, 0, cards.length - 1)
  const aim = (start: number, size: number) => {
    const choice = random()
    const position = choice < 0.15 ? start : choice < 0.3 ? start + size : start + random() * size
    return exact ? Math.round(position * 4) / 4 : position
  }
  input.pointerX = random() < 0.1 ? random() * 4000 - 2000 : aim(layout.lefts[target]!, layout.widths[target]!)
  input.pointerY = aim(layout.tops[target]!, layout.heights[target]!)
  return input
}

// Compares every per-card value and every shared output with ===, and counts the values that differ.
export function countDifferences(left: RowOutputs, right: RowOutputs) {
  let values = 0
  let differing = 0
  for (const field of ['widths', 'heights', 'lefts', 'tops', 'hovered'] as const) {
    for (let index = 0; index < left[field].length; index++) {
      values++
      if (left[field][index] !== right[field][index]) differing++
    }
  }
  for (const field of ['tallest', 'hoveredIndex', 'hoverPresent'] as const) {
    values++
    if (left[field] !== right[field]) differing++
  }
  return {values, differing}
}

// Steps both versions through random frames with fractional inputs and reports what the frames covered.
export function compareVersions(staged: StagedRow, count: number, prefixLowering: PrefixLowering, frames: number, seed: number) {
  const random = createRandom(seed)
  const cards = randomCards(random, count, false)
  const duplicated = createDuplicatedRunner(buildDuplicatedRow(cards, {prefixLowering}))
  const result = {frames, valuesCompared: 0, differingValues: 0, hoveredFrames: 0, overlappingFrames: 0}
  for (let frame = 0; frame < frames; frame++) {
    const input = randomInput(random, cards, false)
    const {values, differing} = countDifferences(duplicated(input), evaluateStagedRow(staged, cards, input))
    result.valuesCompared += values
    result.differingValues += differing
    const reference = layoutRowReference(cards, input)
    if (reference.hoveredIndex !== null) result.hoveredFrames++
    if (input.pointerPresent && reference.cardsUnderPointer >= 2) result.overlappingFrames++
  }
  return result
}

// The runs quoted in the section: 1, 2, 7 and 64 cards, both prefix lowerings, 40 frames each.
export function compareAllVersions(staged: StagedRow) {
  const total = {frames: 0, valuesCompared: 0, differingValues: 0, hoveredFrames: 0, overlappingFrames: 0}
  for (const count of [1, 2, 7, 64]) {
    for (const prefixLowering of ['chain', 'triangle'] as PrefixLowering[]) {
      const run = compareVersions(staged, count, prefixLowering, 40, 1000 + count * 2 + (prefixLowering === 'chain' ? 0 : 1))
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += run[key]
    }
  }
  return total
}
