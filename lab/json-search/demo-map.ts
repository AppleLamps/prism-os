// The demo page's map: one small square cell per document, in the documents' order, row after row from the top left.
// This file is the map's arithmetic, with no DOM: how large a cell is, which document a point picks, and the cells'
// pixels.
//
// Lengths named `...Css` are CSS px, and every other length is a pixel of the canvas, which has `scale` pixels per
// CSS px, e.g. 2 on a screen with two device pixels per CSS px, so that a cell's edges fall on device pixels.

export type MapLayout = {
  scale: number
  documentCount: number
  // The canvas's size.
  width: number
  height: number
  // From one cell's left edge to the next cell's, and a cell's side.
  pitch: number
  cell: number
  columns: number
  rows: number
}

// The cells take at most this much height when a larger cell would still fit, e.g. 20,000 documents get larger cells
// than 100,000. With the smallest cell the map may be taller, e.g. 100,000 documents on a screen with one device pixel
// per CSS px.
const tallestCss = 420
const largestPitchCss = 12
const gapOfPitch = (pitch: number) => Math.max(1, Math.round(pitch / 5))

// The largest cell with which the documents fit the height above, and at least the smallest cell that still shows a
// gap to the next one: 1 canvas pixel of every 2 at scale 1, 2 of every 3 at scale 2, and 3 of every 4 at scale 3.
export function mapLayout(widthCss: number, scale: number, documentCount: number): MapLayout {
  const width = Math.max(1, Math.floor(widthCss * scale))
  const smallestPitch = scale + 1
  let chosen: MapLayout | undefined
  for (let pitch = largestPitchCss * scale; pitch >= smallestPitch; pitch--) {
    const cell = pitch - gapOfPitch(pitch)
    const columns = Math.max(1, Math.floor((width - cell) / pitch) + 1)
    const rows = Math.ceil(documentCount / columns)
    chosen = {scale, documentCount, width, height: (rows - 1) * pitch + cell, pitch, cell, columns, rows}
    if (chosen.height <= tallestCss * scale) break
  }
  return chosen!
}

// The document whose cell a point is over, or -1 where there is no cell. A cell answers for itself and for the gap to
// its right and below it.
export function cellAt(layout: MapLayout, xCss: number, yCss: number): number {
  const column = Math.floor(xCss * layout.scale / layout.pitch)
  const row = Math.floor(yCss * layout.scale / layout.pitch)
  if (column < 0 || column >= layout.columns || row < 0) return -1
  const index = row * layout.columns + column
  return index < layout.documentCount ? index : -1
}

// The center of a document's cell, in CSS px from the map's top left corner.
export function cellCenterCss(layout: MapLayout, index: number): {x: number, y: number} {
  return {
    x: ((index % layout.columns) * layout.pitch + layout.cell / 2) / layout.scale,
    y: (Math.floor(index / layout.columns) * layout.pitch + layout.cell / 2) / layout.scale,
  }
}

// Among the first `searched` documents, the one with a match whose cell is nearest to a point, or -1 when none has a
// match. A pattern that few documents hold marks a few cells among 100,000, each 1 CSS px wide, so the pointer picks
// the nearest one instead of the one under it. One call reads every document's count, 0.1 ms for 100,000.
export function nearestMatch(layout: MapLayout, matchCounts: Float32Array, searched: number, xCss: number, yCss: number): number {
  const {columns, pitch, cell, scale} = layout
  // The point in cells, from the first cell's center.
  const x = (xCss * scale - cell / 2) / pitch
  const y = (yCss * scale - cell / 2) / pitch
  let nearest = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0, column = 0, row = 0; index < searched; index++) {
    if (matchCounts[index]! > 0) {
      const distance = (column - x) * (column - x) + (row - y) * (row - y)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = index
      }
    }
    if (++column === columns) {
      column = 0
      row++
    }
  }
  return nearest
}

// The next document with a match after `from` among the first `searched` documents, or the one before it with step
// -1, going around the ends, as a browser's find bar does. -1 when none has a match. `from` itself is the answer only
// when it is the one document with a match.
export function nextMatch(matchCounts: Float32Array, searched: number, from: number, step: 1 | -1): number {
  for (let distance = 1; distance <= searched; distance++) {
    const index = ((from + step * distance) % searched + searched) % searched
    if (matchCounts[index]! > 0) return index
  }
  return -1
}

// A cell's colors, each as one pixel of an ImageData read as 32-bit words: a document with a match, one without, and
// one that a search in progress hasn't reached yet.
export type CellColors = {match: number, plain: number, waiting: number}

// Writes the pixels of the first `loaded` documents' cells. Of those, the first `searched` are colored by their match
// count, and the others have the color `rest`, e.g. the waiting color while a search on the CPU hasn't reached them.
// `matchCounts` holds a count for each of the first `searched` documents. One call writes e.g. 400,000 pixels for
// 100,000 cells of 2 by 2 pixels, in 0.2 to 0.6 ms in Chrome once the JavaScript engine has compiled the loop. The
// colors are read before the loop and the counts are always an array, since the engine left the compiled loop when a
// color was first read inside it, or when the counts were null for "no search".
export function paintCells(pixels: Uint32Array, layout: MapLayout, loaded: number, searched: number, matchCounts: Float32Array, colors: CellColors, rest: number) {
  const {cell, pitch, width, columns} = layout
  const {match, plain} = colors
  // The index of the current cell's top left pixel, and of its row's first cell's.
  let offset = 0
  let rowOffset = 0
  let column = 0
  for (let index = 0; index < loaded; index++) {
    const color = index >= searched ? rest : matchCounts[index]! > 0 ? match : plain
    if (cell === 1) {
      pixels[offset] = color
    } else if (cell === 2) {
      pixels[offset] = color
      pixels[offset + 1] = color
      pixels[offset + width] = color
      pixels[offset + width + 1] = color
    } else {
      for (let row = 0, start = offset; row < cell; row++, start += width) pixels.fill(color, start, start + cell)
    }
    if (++column === columns) {
      column = 0
      rowOffset += pitch * width
      offset = rowOffset
    } else {
      offset += pitch
    }
  }
}
