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

export type NotesTextLimits = {
  // A segment that doesn't break after itself and is wider than this many px is cut
  // into pieces, e.g. a run of 40 letters typed without a space. The page passes the
  // column's width in the narrowest Notes window, 230 px, so no segment is wider than
  // the column at any window size, and an ordinary long word stays whole.
  longestWholeSegment: number
  // The pieces are at most this many px wide. The page passes the narrowest slot that
  // a band may use, 80 px, so every piece fits every slot.
  pieceWidth: number
}

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

let graphemeSegmenter: Intl.Segmenter | null = null

// A string cut between letters into pieces of at most `pieceWidth` px, each measured
// by itself, e.g. 70 letters of about 7 px each become 7 pieces. A single letter
// wider than `pieceWidth` is a piece of its own. Letters are grapheme clusters, so a
// letter and its combining accent stay together.
export function cutIntoPieces(text: string, pieceWidth: number, measure: MeasureText) {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {granularity: 'grapheme'})
  const pieces: {text: string, width: number}[] = []
  let piece = ''
  let width = 0
  for (const {segment: grapheme} of graphemeSegmenter.segment(text)) {
    const candidate = piece + grapheme
    const candidateWidth = measure(candidate)
    if (piece !== '' && candidateWidth > pieceWidth) {
      pieces.push({text: piece, width})
      piece = grapheme
      width = measure(grapheme)
    } else {
      piece = candidate
      width = candidateWidth
    }
  }
  if (piece !== '') pieces.push({text: piece, width})
  return pieces
}

// pretext's segments as segment cells. Three differences keep any typed text within
// what the program lays out:
// - Segments that break after themselves and follow each other share one cell, e.g.
//   a space and a zero-width space, since the program's walker skips one such
//   segment at a line start.
// - A segment of another kind than text, space or zero-width break is a cell that
//   doesn't break after itself, e.g. a no-break space. pretext keeps such a segment
//   with the words around it, and here a line can break next to it.
// - A segment that doesn't break after itself and is wider than
//   limits.longestWholeSegment is cut into pieces, see cutIntoPieces. The program
//   lays a segment out whole, so without the cut a run of letters wider than the
//   column would run out of the window. A line can break between two pieces, so the
//   run fills each line up to the last piece that fits, where pretext would fill it
//   up to the last letter that fits.
function cellsFromSegments(
  segments: readonly string[],
  widths: readonly number[],
  breaksAfter: readonly boolean[],
  limits: NotesTextLimits,
  measure: MeasureText,
) {
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
    } else if (!breaksAfter[segment]! && width > limits.longestWholeSegment) {
      for (const piece of cutIntoPieces(text, limits.pieceWidth, measure)) {
        texts.push(piece.text)
        cellWidths.push(piece.width)
        breakAfter.push(0)
      }
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
// the width of a space and of the pieces of a long run, and of every segment when
// pretext throws. Widths are rounded to 1/64 px, the grid of the program's width
// cells. `prepare` is pretext's prepareWithSegments, and a parameter so that a test
// can make it throw.
export function prepareNotesText(value: string, font: string, limits: NotesTextLimits, measure: MeasureText, prepare = prepareWithSegments): NotesText {
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
  const cells = cellsFromSegments(measured.segments, measured.widths, measured.breaksAfter, limits, measure)
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

// What the note tells the visitor when the text passes one of the flow's fixed
// capacities, as plain sentences in one line, or '' when the whole text is laid out
// as pretext would lay it out. `segments` is how many segment cells the text needs
// and `capacity` how many the program has; `hiddenWords` is how many words within
// the capacity no band laid out, which are always the last ones; `wrappedLines` is
// the program's windowOverflow output, and `window` how many segments a line holds.
export function notesNotice(counts: {segments: number, capacity: number, hiddenWords: number, wrappedLines: number, window: number}) {
  const sentences: string[] = []
  if (counts.segments > counts.capacity) {
    sentences.push(`This text has ${counts.segments} words and spaces, and the note lays out the first ${counts.capacity}.`)
  }
  if (counts.hiddenWords > 0) {
    sentences.push(counts.hiddenWords === 1
      ? 'The last word doesn\'t fit in the lines that are free.'
      : `The last ${counts.hiddenWords} words don't fit in the lines that are free.`)
  }
  if (counts.wrappedLines > 0) {
    sentences.push(`A line holds ${counts.window} words and spaces at most, so ${counts.wrappedLines === 1 ? '1 line wraps' : `${counts.wrappedLines} lines wrap`} early.`)
  }
  return sentences.join(' ')
}
