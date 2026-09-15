// The familiar JavaScript version of the card row: plain loops over cards, in float64.
import type {Card, RowInput} from './cards-types.ts'

export type ReferenceLayout = {
  widths: number[]
  heights: number[]
  lefts: number[]
  tops: number[]
  tallest: number
  hoveredIndex: number | null
  // How many cards contain the pointer, to measure how often the tests exercise overlapping cards.
  cardsUnderPointer: number
}

export function layoutRowReference(cards: readonly Card[], input: RowInput): ReferenceLayout {
  const widths = cards.map(card => card.naturalWidth * input.zoom)
  const heights = cards.map(card => card.naturalHeight * input.zoom)

  let tallest = heights[0]!
  for (const height of heights) tallest = Math.max(tallest, height)

  const lefts: number[] = []
  let left = input.rowLeft
  for (const width of widths) {
    lefts.push(left)
    left += width + input.gap
  }

  // Each card is centered vertically on the tallest card.
  const tops = heights.map(height => input.rowTop + (tallest - height) / 2)

  // The first card whose rectangle contains the pointer, like index.ts's hitTest2DMode.
  const contains = (index: number) =>
    lefts[index]! <= input.pointerX && input.pointerX < lefts[index]! + widths[index]!
    && tops[index]! <= input.pointerY && input.pointerY < tops[index]! + heights[index]!
  let hoveredIndex: number | null = null
  if (input.pointerPresent) {
    for (let index = 0; index < cards.length; index++) {
      if (contains(index)) {
        hoveredIndex = index
        break
      }
    }
  }

  let cardsUnderPointer = 0
  for (let index = 0; index < cards.length; index++) if (contains(index)) cardsUnderPointer++
  return {widths, heights, lefts, tops, tallest, hoveredIndex, cardsUnderPointer}
}
