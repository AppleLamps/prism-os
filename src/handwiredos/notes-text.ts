// The host's side of a Notes text that a visitor types. A hidden textarea holds the
// characters, the caret, the selection and the undo history, as state the browser
// keeps. This module turns the textarea's value into the segment cells that the
// program lays out, and maps the textarea's character offsets to places in the
// laid-out text, e.g. where the caret is drawn. It never touches the DOM: the caller
// passes what it read from the textarea, a view of the program's outputs, and a
// function that measures a string.
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
    const slot = layout.band(Math.round((place.y - layout.padding) / layout.lineHeight))
    x = Math.max(x, Math.min(x + text.spaceWidth, slot.left + slot.width))
  }
  return {x, y: place.y}
}
