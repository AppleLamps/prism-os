// The demo page's map: one small square mark per document. This file is the map's arithmetic, with no DOM: which group
// a document belongs to, where each mark is, which document a point is over, and the marks' pixels.
//
// The documents are shown in groups, e.g. the seven shapes of documents.ts and, last, the documents that the
// highlighter doesn't call valid. Every group is a block of marks, all blocks have the same number of columns, and a block
// is filled row after row, so a block's height shows how many documents its group has. A wide map has all the blocks
// side by side, and a narrow one has 4 or 2 blocks in a row.
//
// Lengths named `...Css` are CSS px, and every other length is a pixel of the canvas, which has `scale` pixels per
// CSS px, e.g. 2 on a screen with two device pixels per CSS px, so that a mark's edges fall on device pixels.

// The groups' order on the map, in map positions: order[position] is the document at that position, and
// positionOf[document] the position of that document. A group's documents keep their order.
export type MapOrder = {
  order: Uint32Array
  positionOf: Uint32Array
  groupOf: Uint8Array
  groupSizes: number[]
}

// Groups the documents: a valid document goes to the group of its shape, and a document that isn't valid to the last
// group, whatever its shape.
export function groupDocuments(shapeOf: Uint8Array, valid: Uint8Array, shapeCount: number): MapOrder {
  const documentCount = shapeOf.length
  const groupOf = new Uint8Array(documentCount)
  const groupSizes = Array.from({length: shapeCount + 1}, () => 0)
  for (let index = 0; index < documentCount; index++) {
    const group = valid[index] === 1 ? shapeOf[index]! : shapeCount
    groupOf[index] = group
    groupSizes[group]!++
  }
  const next = new Uint32Array(shapeCount + 1)
  for (let group = 1; group <= shapeCount; group++) next[group] = next[group - 1]! + groupSizes[group - 1]!
  const order = new Uint32Array(documentCount)
  const positionOf = new Uint32Array(documentCount)
  for (let index = 0; index < documentCount; index++) {
    const position = next[groupOf[index]!]!++
    order[position] = index
    positionOf[index] = position
  }
  return {order, positionOf, groupOf, groupSizes}
}

// The group sizes that the page lays the map out for before the documents exist, so the map has its height from the
// first paint: 9 documents in 10 are valid, in seven shapes of about the same size, and 1 in 10 has an error. Each
// size is a little more than its share, since a group of the generated documents is its share give or take about 1%
// at 100,000 documents.
export function nominalGroupSizes(documentCount: number, shapeCount: number): number[] {
  const perShape = Math.ceil(documentCount * 0.9 / shapeCount * 1.03)
  return [...Array.from({length: shapeCount}, () => perShape), Math.ceil(documentCount * 0.1 * 1.1)]
}

// What the map's size and the count of documents decide: how many blocks stand in a row, how many columns of marks a
// block has, and how large a mark is.
export type MapGrid = {
  scale: number
  width: number
  blocksPerRow: number
  // From one block's left edge to the next block's.
  blockStride: number
  // From one mark's left edge to the next mark's, and a mark's side.
  pitch: number
  mark: number
  columns: number
}

// Between two blocks of a row, above each block for its label, and between two rows of blocks.
export const blockGapCss = 12
export const labelBandCss = 24
export const blockRowGapCss = 12
// The marks of a map take at most this much height when a larger mark would still fit, e.g. 500 documents get marks
// of 12 CSS px, and 100,000 documents on a screen with one device pixel per CSS px take more than this with the
// smallest mark.
const marksHeightCss = (blocksPerRow: number) => blocksPerRow >= 8 ? 264 : blocksPerRow === 4 ? 420 : 340
const largestPitchCss = 12

const gapOfPitch = (pitch: number) => Math.max(1, Math.round(pitch / 5))
const rowsHeight = (rows: number, pitch: number, mark: number) => rows === 0 ? 0 : (rows - 1) * pitch + mark

// The largest mark with which the documents fit the height above, and at least the smallest mark that still shows a
// gap between two marks: 1 canvas pixel of every 2 at scale 1, 2 of every 3 at scale 2, and 3 of every 4 at scale 3.
export function mapGrid(widthCss: number, scale: number, groupSizes: readonly number[]): MapGrid {
  const width = Math.max(1, Math.floor(widthCss * scale))
  const blocksPerRow = Math.min(groupSizes.length, widthCss >= 960 ? 8 : widthCss >= 560 ? 4 : 2)
  const blockGap = blockGapCss * scale
  const blockWidth = Math.max(1, Math.floor((width - (blocksPerRow - 1) * blockGap) / blocksPerRow))
  const smallestPitch = scale + 1
  let chosen: MapGrid | undefined
  for (let pitch = largestPitchCss * scale; pitch >= smallestPitch; pitch--) {
    const mark = pitch - gapOfPitch(pitch)
    const columns = Math.max(1, Math.floor((blockWidth - mark) / pitch) + 1)
    chosen = {scale, width, blocksPerRow, blockStride: blockWidth + blockGap, pitch, mark, columns}
    let height = 0
    for (let first = 0; first < groupSizes.length; first += blocksPerRow) {
      const largest = Math.max(...groupSizes.slice(first, first + blocksPerRow))
      height += rowsHeight(Math.ceil(largest / columns), pitch, mark)
    }
    if (height <= marksHeightCss(blocksPerRow) * scale) break
  }
  return chosen!
}

export type MapBlock = {
  // The top left corner of the block's first mark.
  x: number
  y: number
  rows: number
  // The block's first map position, and how many documents it holds.
  first: number
  count: number
}
export type MapLayout = MapGrid & {blocks: MapBlock[], height: number}

// Where each group's block is. `nominalSizes` are the sizes that the map's height is reserved for: a row of blocks is
// as tall as the tallest of its blocks, counted with whichever of the two sizes is larger, so the map is as tall
// before the documents exist as after.
export function mapLayout(grid: MapGrid, groupSizes: readonly number[], nominalSizes: readonly number[] = groupSizes): MapLayout {
  const {scale, blocksPerRow, pitch, mark, columns} = grid
  const blocks: MapBlock[] = []
  let y = 0
  let first = 0
  for (let rowStart = 0; rowStart < groupSizes.length; rowStart += blocksPerRow) {
    if (rowStart > 0) y += blockRowGapCss * scale
    y += labelBandCss * scale
    let tallest = 0
    for (let group = rowStart; group < Math.min(groupSizes.length, rowStart + blocksPerRow); group++) {
      const count = groupSizes[group]!
      blocks.push({x: (group - rowStart) * grid.blockStride, y, rows: Math.ceil(count / columns), first, count})
      first += count
      tallest = Math.max(tallest, Math.ceil(Math.max(count, nominalSizes[group] ?? 0) / columns))
    }
    y += rowsHeight(tallest, pitch, mark)
  }
  return {...grid, blocks, height: y}
}

// The map position under a point, or -1 where there is no mark. A mark answers for its whole cell, i.e. for itself
// and for the gap to its right and below it.
export function positionAt(layout: MapLayout, xCss: number, yCss: number): number {
  const x = xCss * layout.scale
  const y = yCss * layout.scale
  for (const block of layout.blocks) {
    if (x < block.x || x >= block.x + layout.columns * layout.pitch || y < block.y || y >= block.y + block.rows * layout.pitch) continue
    const index = Math.floor((y - block.y) / layout.pitch) * layout.columns + Math.floor((x - block.x) / layout.pitch)
    return index < block.count ? block.first + index : -1
  }
  return -1
}

// The center of the mark at a map position, in CSS px from the map's top left corner.
export function markCenterCss(layout: MapLayout, position: number): {x: number, y: number} {
  for (const block of layout.blocks) {
    if (position < block.first || position >= block.first + block.count) continue
    const index = position - block.first
    return {
      x: (block.x + (index % layout.columns) * layout.pitch + layout.mark / 2) / layout.scale,
      y: (block.y + Math.floor(index / layout.columns) * layout.pitch + layout.mark / 2) / layout.scale,
    }
  }
  throw new Error(`the map has no position ${position}`)
}

// For each map position, the index of its mark's top left pixel in the canvas's pixels.
export function markOffsets(layout: MapLayout): Uint32Array {
  const offsets = new Uint32Array(layout.blocks.reduce((total, block) => total + block.count, 0))
  for (const block of layout.blocks) {
    for (let index = 0; index < block.count; index++) {
      const x = block.x + (index % layout.columns) * layout.pitch
      const y = block.y + Math.floor(index / layout.columns) * layout.pitch
      offsets[block.first + index] = y * layout.width + x
    }
  }
  return offsets
}

// A mark's three colors, each as one pixel of an ImageData read as 32-bit words.
export type MarkColors = {valid: number, match: number, error: number}

// Writes every mark's pixels: a document with a match in one color, a valid document without one in a second, and a
// document that isn't valid and has no match in a third. `matchCounts` is one count per document, and all zeros
// before a search. One call writes e.g. 400,000 pixels for 100,000 marks of 2 by 2 pixels, in 0.2 to 0.6 ms in
// Chrome once the JavaScript engine has compiled the loop, and two things keep the loop in that compiled code:
// - The three colors are read before the loop. Read inside it, the match's color was first read in the second
//   paint, since the first paint has no match, and the engine left the compiled loop there: the third paint of a
//   page took 4 to 6 ms instead of 1 ms.
// - The counts are always an array, also for "no search", where null made the second paint take 1.0 ms instead of
//   0.5 ms.
export function paintMarks(pixels: Uint32Array, layout: MapLayout, offsets: Uint32Array, order: Uint32Array, valid: Uint8Array, matchCounts: Float32Array, colors: MarkColors) {
  const {mark, width} = layout
  const {valid: validColor, match: matchColor, error: errorColor} = colors
  const count = offsets.length
  for (let position = 0; position < count; position++) {
    const index = order[position]!
    const color = matchCounts[index]! > 0 ? matchColor : valid[index] === 1 ? validColor : errorColor
    const offset = offsets[position]!
    if (mark === 1) {
      pixels[offset] = color
    } else if (mark === 2) {
      pixels[offset] = color
      pixels[offset + 1] = color
      pixels[offset + width] = color
      pixels[offset + width + 1] = color
    } else {
      for (let row = 0, start = offset; row < mark; row++, start += width) pixels.fill(color, start, start + mark)
    }
  }
}

// How many documents of each group have a match.
export function matchesByGroup(matchCounts: Float32Array, groupOf: Uint8Array, groupCount: number): number[] {
  const counts = Array.from({length: groupCount}, () => 0)
  for (let index = 0; index < matchCounts.length; index++) if (matchCounts[index]! > 0) counts[groupOf[index]!]!++
  return counts
}

// The next document with a match after `from`, or before it with step -1, going around the ends. -1 when no document
// has a match. `from` itself is the answer only when it is the one document with a match.
export function nextDocumentWithMatch(matchCounts: Float32Array, from: number, step: 1 | -1): number {
  const count = matchCounts.length
  for (let distance = 1; distance <= count; distance++) {
    const index = ((from + step * distance) % count + count) % count
    if (matchCounts[index]! > 0) return index
  }
  return -1
}
