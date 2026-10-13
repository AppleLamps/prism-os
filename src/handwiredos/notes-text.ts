// The host's side of a Notes text that a visitor types. A hidden textarea holds the
// characters, the caret, the selection and the undo history, as state the browser
// keeps. This module turns the textarea's value into the segment cells that the
// program lays out, and maps between the textarea's character offsets and places in
// the laid-out text, e.g. where the caret is drawn, and which character a press
// lands on. It never touches the DOM: the caller passes what it read from the
// textarea, a view of the program's outputs, and a function that measures a string.
import {prepareWithSegments} from '@chenglou/pretext'
import type {FastParagraph} from './notes-walker.ts'

// The width of a string in the note's font, in px, e.g. from a canvas's measureText.
export type MeasureText = (text: string) => number

export type NotesText = {
  // The textarea value this was prepared from.
  value: string
  // The value as it is laid out, like pretext sees it: every run of spaces, tabs and
  // line breaks is one space, and no space comes first or last.
  normalized: string
  // normalizedOffsets[offset] is the place in `normalized` of a caret at `offset` in
  // the value, e.g. in 'a  b' the offsets 0 to 4 map to 0, 1, 2, 2 and 3.
  normalizedOffsets: number[]
  // Where the value's trailing white space starts, or the value's length when it
  // ends with another character. That white space isn't laid out, so a caret after
  // it is drawn one space after the last segment.
  trailingWhitespaceStart: number
  // One entry per segment cell that the text needs, which can be more than the
  // program has cells: the text that the cell draws.
  cellTexts: string[]
  // cellStarts[cell] is the place in `normalized` of the cell's first character, and
  // the last entry is the length of `normalized`.
  cellStarts: number[]
  // The cells' widths, on the 1/64 px grid, and break-after bits, as the machine's
  // notesText takes them.
  paragraph: FastParagraph
  // The width of one space, for the caret after trailing white space.
  spaceWidth: number
}

const collapsibleWhitespace = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c])

// pretext's white space rule (normalizeWhitespaceNormal in its analysis.ts), which
// also records where each character of the value lands.
export function normalizeNotesValue(value: string) {
  const normalizedOffsets: number[] = []
  let normalized = ''
  let inWhitespace = false
  let trailingWhitespaceStart = value.length
  for (let offset = 0; offset < value.length; offset++) {
    normalizedOffsets.push(normalized.length)
    if (collapsibleWhitespace.has(value.charCodeAt(offset))) {
      if (!inWhitespace) {
        trailingWhitespaceStart = offset
        if (normalized.length > 0) normalized += ' '
      }
      inWhitespace = true
    } else {
      normalized += value[offset]
      inWhitespace = false
      trailingWhitespaceStart = value.length
    }
  }
  normalizedOffsets.push(normalized.length)
  if (normalized.endsWith(' ')) normalized = normalized.slice(0, -1)
  for (let offset = 0; offset < normalizedOffsets.length; offset++) {
    normalizedOffsets[offset] = Math.min(normalizedOffsets[offset]!, normalized.length)
  }
  return {normalized, normalizedOffsets, trailingWhitespaceStart}
}

// pretext's segments as segment cells. Two differences keep any typed text within
// what the program lays out:
// - Segments that break after themselves and follow each other share one cell, e.g.
//   a space and a zero-width space, since the program's walker skips one such
//   segment at a line start.
// - A segment of another kind than text, space or zero-width break is a cell that
//   doesn't break after itself, e.g. a no-break space. pretext keeps such a segment
//   with the words around it, and here a line can break next to it.
function cellsFromSegments(segments: readonly string[], widths: readonly number[], breaksAfter: readonly boolean[]) {
  const texts: string[] = []
  const cellWidths: number[] = []
  const breakAfter: number[] = []
  for (let segment = 0; segment < segments.length; segment++) {
    const text = segments[segment]!
    const width = widths[segment]!
    const last = texts.length - 1
    if (breaksAfter[segment]! && breakAfter[last] === 1) {
      texts[last] += text
      cellWidths[last]! += width
    } else {
      texts.push(text)
      cellWidths.push(width)
      breakAfter.push(breaksAfter[segment]! ? 1 : 0)
    }
  }
  return {texts, widths: cellWidths, breakAfter}
}

// Words and the single spaces between them, measured one by one. prepareNotesText
// falls back to this when pretext throws, so that a text pretext can't prepare is
// still laid out, with a line break possible at every space.
function segmentAtSpaces(normalized: string, measure: MeasureText) {
  const segments = normalized.split(/( )/).filter(segment => segment !== '')
  return {segments, widths: segments.map(measure), breaksAfter: segments.map(segment => segment === ' ')}
}

// A textarea value as segment cells, measured in `font` by pretext. `measure` gives
// the width of a space, and of every segment when pretext throws. Widths are rounded
// to 1/64 px, the grid of the program's width cells. `prepare` is pretext's
// prepareWithSegments, and a parameter so that a test can make it throw.
export function prepareNotesText(value: string, font: string, measure: MeasureText, prepare = prepareWithSegments): NotesText {
  const {normalized, normalizedOffsets, trailingWhitespaceStart} = normalizeNotesValue(value)
  let measured: {segments: readonly string[], widths: readonly number[], breaksAfter: readonly boolean[]}
  try {
    const prepared = prepare(normalized, font)
    measured = {
      segments: prepared.segments,
      widths: prepared.widths,
      breaksAfter: prepared.kinds.map(kind => kind === 'space' || kind === 'zero-width-break'),
    }
  } catch {
    measured = segmentAtSpaces(normalized, measure)
  }
  const cells = cellsFromSegments(measured.segments, measured.widths, measured.breaksAfter)
  const cellStarts: number[] = []
  let start = 0
  for (const text of cells.texts) {
    cellStarts.push(Math.min(start, normalized.length))
    start += text.length
  }
  cellStarts.push(normalized.length)
  return {
    value,
    normalized,
    normalizedOffsets,
    trailingWhitespaceStart,
    cellTexts: cells.texts,
    cellStarts,
    paragraph: {
      widths: cells.widths.map(width => Number.isFinite(width) ? Math.round(width * 64) / 64 : 0),
      breakAfter: cells.breakAfter,
    },
    spaceWidth: measure(' '),
  }
}

// A view of the program's Notes outputs for one frame: where each segment cell is,
// and each band's slot. Coordinates are local to the Notes content box.
export type NotesLayout = {
  lineHeight: number
  // The top of the first band.
  padding: number
  bands: number
  // The outputs of a segment cell: its x and y, and whether a band laid it out.
  cell(cell: number): {x: number, y: number, visible: boolean}
  // The outputs of a band: whether it has a slot, and the slot's left edge and width.
  band(band: number): {usable: boolean, left: number, width: number}
}

// The band whose line has its top at y.
const bandOf = (layout: NotesLayout, y: number) => Math.round((y - layout.padding) / layout.lineHeight)

// The cell that holds a caret at `offset` of the value, and how many characters of
// the cell come before the caret. A caret at a cell's first character belongs to
// that cell, so a caret before the first word of a line is drawn on that line, and
// a caret after the last character belongs to the last cell. null when the text has
// no cells.
export function caretCell(text: NotesText, offset: number) {
  const cellCount = text.cellTexts.length
  if (cellCount === 0) return null
  const place = text.normalizedOffsets[Math.max(0, Math.min(text.value.length, offset))]!
  let cell = cellCount - 1
  for (let candidate = 0; candidate < cellCount; candidate++) {
    if (place < text.cellStarts[candidate + 1]!) {
      cell = candidate
      break
    }
  }
  return {
    cell,
    charactersBefore: place - text.cellStarts[cell]!,
    afterTrailingWhitespace: place === text.normalized.length && offset > text.trailingWhitespaceStart,
  }
}

// The width of the first `characters` characters of a cell's text.
function prefixWidth(text: NotesText, cell: number, characters: number, measure: MeasureText) {
  const cellText = text.cellTexts[cell]!
  if (characters <= 0) return 0
  if (characters >= cellText.length) return text.paragraph.widths[cell]!
  return measure(cellText.slice(0, characters))
}

// Where the caret at `offset` of the value is drawn: the left edge and the top of a
// bar one line tall, or null when the caret's place isn't laid out, e.g. in a word
// that no band holds, or past the cells' capacity. `laidOutCells` is how many of the
// text's cells the program holds. In an empty note, the caret sits at the left edge
// of the first usable band. After trailing white space, which isn't laid out, the
// caret sits one space after the last character, and no further than the band's
// right edge.
export function caretPosition(text: NotesText, laidOutCells: number, offset: number, layout: NotesLayout, measure: MeasureText) {
  const caret = caretCell(text, offset)
  if (caret === null) {
    for (let band = 0; band < layout.bands; band++) {
      const slot = layout.band(band)
      if (slot.usable) return {x: slot.left, y: layout.padding + band * layout.lineHeight}
    }
    return null
  }
  if (caret.cell >= laidOutCells) return null
  const place = layout.cell(caret.cell)
  if (!place.visible) return null
  let x = place.x + prefixWidth(text, caret.cell, caret.charactersBefore, measure)
  if (caret.afterTrailingWhitespace) {
    const slot = layout.band(bandOf(layout, place.y))
    x = Math.max(x, Math.min(x + text.spaceWidth, slot.left + slot.width))
  }
  return {x, y: place.y}
}

// The selected stretch of each band's line, as its left and right edge, or null for
// a band without selected text: from the first selected character on the band's
// line to the last. `selectionStart` and `selectionEnd` are offsets of the value.
export function selectionSpans(
  text: NotesText,
  laidOutCells: number,
  selectionStart: number,
  selectionEnd: number,
  layout: NotesLayout,
  measure: MeasureText,
) {
  const spans = Array.from({length: layout.bands}, (): {left: number, right: number} | null => null)
  const clampOffset = (offset: number) => Math.max(0, Math.min(text.value.length, offset))
  const from = text.normalizedOffsets[clampOffset(selectionStart)]!
  const to = text.normalizedOffsets[clampOffset(selectionEnd)]!
  if (to <= from) return spans
  for (let cell = 0; cell < Math.min(laidOutCells, text.cellTexts.length); cell++) {
    const cellStart = text.cellStarts[cell]!
    const cellEnd = text.cellStarts[cell + 1]!
    if (cellEnd <= from || cellStart >= to) continue
    const place = layout.cell(cell)
    if (!place.visible) continue
    const band = bandOf(layout, place.y)
    if (band < 0 || band >= layout.bands) continue
    const left = place.x + prefixWidth(text, cell, from - cellStart, measure)
    const right = place.x + prefixWidth(text, cell, to - cellStart, measure)
    const span = spans[band] ?? null
    spans[band] = span === null ? {left, right} : {left: Math.min(span.left, left), right: Math.max(span.right, right)}
  }
  return spans
}

// The offset of the value whose caret is nearest to a point of the content box: on
// the laid-out line nearest to the point's y, the cell under the point's x, then the
// boundary between two characters of that cell that is nearest to x. Right of a
// line's last cell, the offset is the line's end. 0 when no cell is laid out.
//
// Several offsets of the value can share a place, since white space collapses, e.g.
// in 'cd  ef' the offsets between the two spaces and before the 'e' both lie at the
// start of 'ef'. Before a cell's first character the result is the last of them,
// so a character typed there joins the word, and elsewhere it is the first, e.g.
// right after the text's last character and not after its trailing spaces.
export function offsetAtPoint(text: NotesText, laidOutCells: number, layout: NotesLayout, measure: MeasureText, x: number, y: number) {
  const cellCount = Math.min(laidOutCells, text.cellTexts.length)
  let lineY: number | null = null
  for (let cell = 0; cell < cellCount; cell++) {
    const place = layout.cell(cell)
    if (!place.visible) continue
    if (lineY === null || Math.abs(place.y + layout.lineHeight / 2 - y) < Math.abs(lineY + layout.lineHeight / 2 - y)) lineY = place.y
  }
  if (lineY === null) return 0
  let chosen = -1
  let lastOnLine = -1
  for (let cell = 0; cell < cellCount; cell++) {
    const place = layout.cell(cell)
    if (!place.visible || place.y !== lineY) continue
    lastOnLine = cell
    if (chosen < 0 && x < place.x + text.paragraph.widths[cell]!) chosen = cell
  }
  // The first offset of the value at a place of the laid-out text, or the last one.
  const valueOffsetOf = (place: number, which: 'first' | 'last') => {
    let offset = 0
    while (offset < text.value.length && text.normalizedOffsets[offset]! < place) offset++
    if (which === 'last') while (offset < text.value.length && text.normalizedOffsets[offset + 1]! <= place) offset++
    return offset
  }
  if (chosen < 0) {
    // Right of the line: after its last cell, or before the space that hangs at its end.
    const hangs = text.paragraph.breakAfter[lastOnLine] === 1
    return valueOffsetOf(hangs ? text.cellStarts[lastOnLine]! : text.cellStarts[lastOnLine + 1]!, 'first')
  }
  const place = layout.cell(chosen)
  const cellText = text.cellTexts[chosen]!
  let characters = 0
  let previousEdge = 0
  // By code point, so the caret never lands between the two halves of a surrogate pair.
  for (const character of cellText) {
    const edge = prefixWidth(text, chosen, characters + character.length, measure)
    if (x - place.x < (previousEdge + edge) / 2) break
    characters += character.length
    previousEdge = edge
  }
  return valueOffsetOf(text.cellStarts[chosen]! + characters, characters === 0 ? 'last' : 'first')
}

// The caret moves that follow the laid-out lines: one line up or down, and to the
// start or the end of the caret's line. The textarea can't make them by itself,
// since its own text is one long line.
export type LineMove = 'up' | 'down' | 'lineStart' | 'lineEnd'

// Where a line move takes a caret at `offset` of the value: the new offset, and the
// x that the move aimed for. A run of up and down moves keeps aiming for the x where
// the run started, which the caller passes back as `preferredX`, so the caret
// returns to its column after a short line. Up from the first line goes to the
// start of the text and down from the last line to its end, like in a textarea, and
// so does a caret whose place isn't laid out.
export function offsetAfterLineMove(
  text: NotesText,
  laidOutCells: number,
  offset: number,
  move: LineMove,
  preferredX: number | null,
  layout: NotesLayout,
  measure: MeasureText,
) {
  const caret = caretPosition(text, laidOutCells, offset, layout, measure)
  const vertical = move === 'up' || move === 'down'
  if (!vertical) {
    if (caret === null) return {offset, x: 0}
    const x = move === 'lineStart' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    return {offset: offsetAtPoint(text, laidOutCells, layout, measure, x, caret.y + layout.lineHeight / 2), x}
  }
  const x = preferredX ?? caret?.x ?? 0
  // The top of the nearest laid-out line above or below the caret's line.
  let lineY: number | null = null
  if (caret !== null) {
    for (let cell = 0; cell < Math.min(laidOutCells, text.cellTexts.length); cell++) {
      const place = layout.cell(cell)
      if (!place.visible) continue
      if (move === 'up' ? place.y < caret.y && (lineY === null || place.y > lineY) : place.y > caret.y && (lineY === null || place.y < lineY)) lineY = place.y
    }
  }
  if (lineY === null) return {offset: move === 'up' ? 0 : text.value.length, x}
  return {offset: offsetAtPoint(text, laidOutCells, layout, measure, x, lineY + layout.lineHeight / 2), x}
}
