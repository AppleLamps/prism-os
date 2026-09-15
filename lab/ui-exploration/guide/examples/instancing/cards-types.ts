// Shared types for the card row examples: a row of cards laid out left to right with a gap,
// centered vertically on the tallest card, where the first card under the pointer is hovered.

export type Card = {naturalWidth: number, naturalHeight: number}

export type RowInput = {
  zoom: number
  // A negative gap makes neighboring cards overlap, so more than one card can contain the pointer.
  gap: number
  rowLeft: number
  rowTop: number
  pointerX: number
  pointerY: number
  pointerPresent: boolean
}

// What both circuit versions produce. Per-card values are one Float32Array per field, one number per card.
export type RowOutputs = {
  widths: Float32Array
  heights: Float32Array
  lefts: Float32Array
  tops: Float32Array
  hovered: Float32Array
  tallest: number
  // 0 when no card is hovered; hoverPresent is 1 when a card is hovered.
  hoveredIndex: number
  hoverPresent: number
}

export const sharedCells = ['zoom', 'gap', 'rowLeft', 'rowTop', 'pointerX', 'pointerY', 'pointerPresent'] as const
export type SharedCell = typeof sharedCells[number]

// Declared source ranges are contracts: the evaluator rejects a source table outside them.
export const sharedRanges: Record<SharedCell, readonly [minimum: number, maximum: number]> = {
  zoom: [0.25, 2],
  gap: [-64, 64],
  rowLeft: [-4096, 4096],
  rowTop: [-4096, 4096],
  pointerX: [-(2 ** 20), 2 ** 20],
  pointerY: [-(2 ** 20), 2 ** 20],
  pointerPresent: [0, 1],
}
