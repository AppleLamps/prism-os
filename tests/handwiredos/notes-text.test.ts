// The host's helpers for a typed Notes text: the textarea value as segment cells,
// and the caret's place from the program's outputs.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {prepareWithSegments} from '@chenglou/pretext'
import {fakeTextWidth, testFont} from './fake-canvas.ts'
import {
  type NotesLayout,
  caretCell,
  caretPosition,
  cutIntoPieces,
  normalizeNotesValue,
  notesNotice,
  offsetAfterLineMove,
  offsetAtPoint,
  prepareNotesText,
  selectionSpans,
} from '../../src/handwiredos/notes-text.ts'

const measure = (text: string) => fakeTextWidth(text, testFont)
// The page's limits: a run wider than the narrowest column is cut into pieces that fit the narrowest slot.
const limits = {longestWholeSegment: 230, pieceWidth: 80}
const prepare = (value: string) => prepareNotesText(value, testFont, limits, measure)

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

test('a value is normalized like pretext normalizes it, and every offset of the value has a place in the result', () => {
  assert.deepEqual(normalizeNotesValue('a  b'), {normalized: 'a b', normalizedOffsets: [0, 1, 2, 2, 3], trailingWhitespaceStart: 4})
  assert.deepEqual(normalizeNotesValue(' a b '), {normalized: 'a b', normalizedOffsets: [0, 0, 1, 2, 3, 3], trailingWhitespaceStart: 4})
  assert.deepEqual(normalizeNotesValue('a\n\tb\r\n'), {normalized: 'a b', normalizedOffsets: [0, 1, 2, 2, 3, 3, 3], trailingWhitespaceStart: 4})
  assert.deepEqual(normalizeNotesValue(''), {normalized: '', normalizedOffsets: [0], trailingWhitespaceStart: 0})
  assert.deepEqual(normalizeNotesValue('   '), {normalized: '', normalizedOffsets: [0, 0, 0, 0], trailingWhitespaceStart: 0})
  // Random values of letters and white space: pretext's segments spell the normalized value, and the offsets never
  // go backwards and end at its length.
  const random = createRandom(3)
  const characters = ['a', 'b', 'c', ',', ' ', ' ', '\n', '\t']
  for (let trial = 0; trial < 400; trial++) {
    const value = Array.from({length: Math.floor(random() * 30)}, () => characters[Math.floor(random() * characters.length)]!).join('')
    const {normalized, normalizedOffsets} = normalizeNotesValue(value)
    assert.equal(prepareWithSegments(value, testFont).segments.join(''), normalized, JSON.stringify(value))
    assert.equal(normalizedOffsets.length, value.length + 1)
    assert.equal(normalizedOffsets.at(-1), normalized.length)
    assert.ok(normalizedOffsets.every((place, offset) => offset === 0 || place >= normalizedOffsets[offset - 1]!))
  }
})

test('a plain text gets one cell per pretext segment, with pretext\'s widths', () => {
  const text = prepare('  The lines break where pretext would break them.  ')
  const prepared = prepareWithSegments('The lines break where pretext would break them.', testFont)
  assert.equal(text.normalized, 'The lines break where pretext would break them.')
  assert.deepEqual(text.cellTexts, prepared.segments)
  assert.deepEqual(text.cellTexts, ['The', ' ', 'lines', ' ', 'break', ' ', 'where', ' ', 'pretext', ' ', 'would', ' ', 'break', ' ', 'them.'])
  assert.deepEqual(text.paragraph.widths, prepared.widths)
  assert.deepEqual(text.paragraph.breakAfter, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
  assert.deepEqual(text.cellStarts, [0, 3, 4, 9, 10, 15, 16, 21, 22, 29, 30, 35, 36, 41, 42, 47])
  assert.equal(text.spaceWidth, 4.375)
  assert.equal(text.trailingWhitespaceStart, 49)
  const empty = prepare('  \n ')
  assert.deepEqual([empty.cellTexts, empty.cellStarts, empty.paragraph], [[], [0], {widths: [], breakAfter: []}])
})

test('characters that pretext\'s fast walker doesn\'t lay out still get cells, and no two break-after cells follow each other', () => {
  // A zero-width space after a space: pretext reports two segments that break after themselves, and they share a cell.
  const zeroWidthSpace = prepare('ab ​cd')
  const raw = prepareWithSegments('ab ​cd', testFont)
  assert.deepEqual(raw.kinds, ['text', 'space', 'zero-width-break', 'text'])
  assert.deepEqual(zeroWidthSpace.cellTexts, ['ab', ' ​', 'cd'])
  assert.deepEqual(zeroWidthSpace.paragraph.breakAfter, [0, 1, 0])
  assert.equal(zeroWidthSpace.paragraph.widths[1], raw.widths[1]! + raw.widths[2]!)
  assert.deepEqual(zeroWidthSpace.cellStarts, [0, 2, 4, 6])
  // A soft hyphen leaves pretext's fast path. Its segment becomes a cell that doesn't break after itself.
  const softHyphen = prepare('co­operate now')
  assert.equal(prepareWithSegments('co­operate now', testFont).simpleLineWalkFastPath, false)
  assert.equal(softHyphen.cellTexts.join(''), 'co­operate now')
  assert.deepEqual(softHyphen.paragraph.breakAfter, softHyphen.cellTexts.map(cell => cell === ' ' ? 1 : 0))
  // Every width is a multiple of 1/64 px within the cells' range, whatever the characters.
  for (const value of ['a b c', 'x⁠y', 'tab\there', '​​​', 'emoji \u{1F600} and 123', 'kanji 漢字']) {
    const text = prepare(value)
    assert.equal(text.cellTexts.join(''), text.normalized, JSON.stringify(value))
    assert.ok(text.paragraph.widths.every(width => Number.isInteger(width * 64) && width >= 0 && width < 512), JSON.stringify(value))
    assert.ok(text.paragraph.breakAfter.every((bit, cell) => bit === 0 || text.paragraph.breakAfter[cell - 1] !== 1), JSON.stringify(value))
    assert.equal(text.cellStarts.length, text.cellTexts.length + 1)
  }
})

test('when pretext throws, the text is cut at its spaces and measured by the host', () => {
  const text = prepareNotesText(' two  words here ', testFont, limits, measure, () => {
    throw new Error('pretext failed')
  })
  assert.deepEqual(text.cellTexts, ['two', ' ', 'words', ' ', 'here'])
  assert.deepEqual(text.paragraph.breakAfter, [0, 1, 0, 1, 0])
  assert.deepEqual(text.paragraph.widths, ['two', ' ', 'words', ' ', 'here'].map(measure))
  assert.deepEqual(text.cellStarts, [0, 3, 4, 9, 10, 14])
})

// A layout of lines as the program would output them: each line's first cell, left edge and band. Cells follow
// each other on a line, each as wide as its width cell.
function layoutOfLines(widths: readonly number[], lines: {firstCell: number, left: number, band: number}[], slotWidth = 440): NotesLayout {
  const places = widths.map(() => ({x: 0, y: 0, visible: false}))
  lines.forEach((line, index) => {
    const end = lines[index + 1]?.firstCell ?? widths.length
    let x = line.left
    for (let cell = line.firstCell; cell < end; cell++) {
      places[cell] = {x, y: 24 + 22 * line.band, visible: true}
      x += widths[cell]!
    }
  })
  return {
    lineHeight: 22,
    padding: 24,
    bands: 16,
    cell: cell => places[cell]!,
    band: band => ({usable: lines.some(line => line.band === band), left: lines.find(line => line.band === band)?.left ?? 0, width: slotWidth}),
  }
}

test('a caret belongs to the cell whose text follows it, and to the last cell at the end of the text', () => {
  const text = prepare('ab cd  ef ')
  assert.deepEqual(text.cellTexts, ['ab', ' ', 'cd', ' ', 'ef'])
  const cells = Array.from({length: text.value.length + 1}, (_, offset) => caretCell(text, offset))
  assert.deepEqual(cells.map(caret => [caret!.cell, caret!.charactersBefore]), [
    // a b _ c d _ _ e f _ end
    [0, 0], [0, 1], [1, 0], [2, 0], [2, 1], [3, 0], [4, 0], [4, 0], [4, 1], [4, 2], [4, 2],
  ])
  assert.deepEqual(cells.map(caret => caret!.afterTrailingWhitespace), [false, false, false, false, false, false, false, false, false, false, true])
  assert.equal(caretCell(prepare(''), 0), null)
  assert.equal(caretCell(prepare('   '), 2), null)
  // Offsets outside the value are clamped.
  assert.deepEqual([caretCell(text, -5)!.cell, caretCell(text, 99)!.cell], [0, 4])
})

test('the caret is drawn at its cell\'s place plus the width of the characters before it', () => {
  const text = prepare('ab cd ef')
  const widths = text.paragraph.widths
  // 'ab cd ' on band 0 from x 24, and 'ef' on band 2 from x 100.
  const layout = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}, {firstCell: 4, left: 100, band: 2}])
  const at = (offset: number) => caretPosition(text, 5, offset, layout, measure)
  assert.deepEqual(at(0), {x: 24, y: 24})
  assert.deepEqual(at(1), {x: 24 + measure('a'), y: 24})
  // After 'ab', the caret belongs to the space's cell, which starts where 'ab' ends.
  assert.deepEqual(at(2), {x: 24 + widths[0]!, y: 24})
  // After 'cd ', the caret belongs to 'ef', at the start of the next line.
  assert.deepEqual(at(6), {x: 100, y: 68})
  assert.deepEqual(at(7), {x: 100 + measure('e'), y: 68})
  assert.deepEqual(at(8), {x: 100 + widths[4]!, y: 68})
  // A cell that the program doesn't hold, or that no band laid out, has no caret.
  assert.equal(caretPosition(text, 4, 7, layout, measure), null)
  const hidden = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}])
  assert.equal(caretPosition(text, 5, 7, {...hidden, cell: cell => cell === 4 ? {x: 0, y: 0, visible: false} : hidden.cell(cell)}, measure), null)
})

test('after trailing white space the caret sits one space further, up to the band\'s right edge, and an empty note has its caret in the first usable band', () => {
  const text = prepare('ab cd ')
  const widths = text.paragraph.widths
  const end = 24 + widths[0]! + widths[1]! + widths[2]!
  const wide = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}])
  assert.deepEqual(caretPosition(text, 3, 5, wide, measure), {x: end, y: 24})
  assert.deepEqual(caretPosition(text, 3, 6, wide, measure), {x: end + 4.375, y: 24})
  // A slot that ends 2 px after the last word: the caret stops at the slot's right edge.
  const narrow = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}], end + 2 - 24)
  assert.deepEqual(caretPosition(text, 3, 6, narrow, measure), {x: end + 2, y: 24})
  const empty = prepare('')
  const bands = layoutOfLines([], [])
  assert.equal(caretPosition(empty, 0, 0, bands, measure), null)
  const thirdBandUsable: NotesLayout = {...bands, band: band => ({usable: band === 2, left: 239, width: 205})}
  assert.deepEqual(caretPosition(empty, 0, 0, thirdBandUsable, measure), {x: 239, y: 68})
})

test('a point maps to the offset whose caret is nearest: the nearest line, the cell under the point, the nearest character boundary', () => {
  const text = prepare('ab cd  ef gh')
  assert.deepEqual(text.cellTexts, ['ab', ' ', 'cd', ' ', 'ef', ' ', 'gh'])
  const widths = text.paragraph.widths
  // 'ab cd ' on band 0 from x 24, where the last space hangs, and 'ef gh' on band 1 from x 100.
  const layout = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}, {firstCell: 4, left: 100, band: 1}])
  const at = (x: number, y: number) => offsetAtPoint(text, 7, layout, measure, x, y)
  const a = measure('a')
  // Inside 'ab': left of the middle of a letter is before the letter, right of it is after.
  assert.deepEqual([at(24 + a * 0.4, 30), at(24 + a * 0.6, 30), at(24 + a + 1, 30)], [0, 1, 1])
  // Left of the line, and above the first line: the line's first offset.
  assert.deepEqual([at(-50, 30), at(10, -200)], [0, 0])
  // Inside 'cd', whose first character is offset 3 of the value.
  assert.equal(at(24 + widths[0]! + widths[1]! + measure('c') * 0.9, 40), 4)
  // Right of the first line: before the space that hangs at its end, i.e. after 'cd'.
  assert.equal(at(400, 35), 5)
  // The second line starts at 'ef', offset 7 of the value, after the two spaces.
  assert.deepEqual([at(100, 50), at(0, 60), at(100 + measure('e') * 0.9, 60)], [7, 7, 8])
  // Right of the last line: the end of the text. Far below the last line: the offset at that x on the last line,
  // here after the space between 'ef' and 'gh'.
  assert.deepEqual([at(900, 60), at(900, 900), at(120, 900)], [12, 12, 10])
  // The line nearest to the point: 46 is the boundary between the two bands. At x 100, the first line has ended,
  // and the second line starts.
  assert.deepEqual([at(100, 45), at(100, 47)], [5, 7])
  // Only the cells that the program holds and a band laid out count.
  assert.equal(offsetAtPoint(text, 4, layout, measure, 900, 60), 5)
  assert.equal(offsetAtPoint(prepare(''), 0, layoutOfLines([], []), measure, 50, 50), 0)
  // A surrogate pair is one character: the caret never lands inside it.
  const emoji = prepare('a\u{1F600}b')
  const emojiLayout = layoutOfLines(emoji.paragraph.widths, [{firstCell: 0, left: 0, band: 0}])
  const offsets = new Set(Array.from({length: 200}, (_, x) => offsetAtPoint(emoji, emoji.cellTexts.length, emojiLayout, measure, x / 4, 30)))
  assert.deepEqual([...offsets].sort((left, right) => left - right), [0, 1, 3, 4])
})

test('a selection is one stretch per band, from its first selected character on the band\'s line to its last', () => {
  const text = prepare('ab cd  ef gh')
  const widths = text.paragraph.widths
  const layout = layoutOfLines(widths, [{firstCell: 0, left: 24, band: 0}, {firstCell: 4, left: 100, band: 2}])
  const spans = (start: number, end: number, laidOutCells = 7) => selectionSpans(text, laidOutCells, start, end, layout, measure)
  const none = Array.from({length: 16}, () => null)
  const withSpans = (...entries: [band: number, left: number, right: number][]) => {
    const expected: ({left: number, right: number} | null)[] = [...none]
    for (const [band, left, right] of entries) expected[band] = {left, right}
    return expected
  }
  const cd = 24 + widths[0]! + widths[1]!
  // No selection.
  assert.deepEqual(spans(3, 3), none)
  // 'b c': from the middle of 'ab' to the middle of 'cd'.
  assert.deepEqual(spans(1, 4), withSpans([0, 24 + measure('a'), cd + measure('c')]))
  // 'cd  ef': to the end of the first line with its hanging space, and the start of the second.
  assert.deepEqual(spans(3, 9), withSpans([0, cd, cd + widths[2]! + widths[3]!], [2, 100, 100 + widths[4]!]))
  // Everything.
  assert.deepEqual(spans(0, 12), withSpans([0, 24, cd + widths[2]! + widths[3]!], [2, 100, 100 + widths[4]! + widths[5]! + widths[6]!]))
  // Cells that the program doesn't hold have no stretch.
  assert.deepEqual(spans(0, 12, 4), withSpans([0, 24, cd + widths[2]! + widths[3]!]))
})

test('line moves follow the laid-out lines: up and down keep their x through a short line, and line start and end stay on the caret\'s line', () => {
  const text = prepare('abcdefgh ij klmnopqr')
  assert.deepEqual(text.cellTexts, ['abcdefgh', ' ', 'ij', ' ', 'klmnopqr'])
  // Three lines from x 24: 'abcdefgh ', the short 'ij ', and 'klmnopqr', on bands 0, 1 and 3. Band 2 has no line.
  const layout = layoutOfLines(text.paragraph.widths, [{firstCell: 0, left: 24, band: 0}, {firstCell: 2, left: 24, band: 1}, {firstCell: 4, left: 24, band: 3}])
  const move = (offset: number, direction: 'up' | 'down' | 'lineStart' | 'lineEnd', preferredX: number | null = null) =>
    offsetAfterLineMove(text, 5, offset, direction, preferredX, layout, measure)
  // From after 'abcdef' on the first line, down lands at the end of the short line, and keeps aiming for the x it
  // started from: the next down lands after 'klmnop', the place nearest to that x, across the band without a line.
  const startX = 24 + measure('abcdef')
  const first = move(6, 'down')
  assert.deepEqual(first, {offset: 11, x: startX})
  const second = move(first.offset, 'down', first.x)
  assert.deepEqual(second, {offset: 12 + 6, x: startX})
  // Without the kept x, the second down would start from the short line's end, after 'ij'.
  assert.equal(move(first.offset, 'down').offset, 12 + 2)
  // Up the same way, back to where the run started.
  assert.deepEqual(move(second.offset, 'up', second.x), {offset: 11, x: startX})
  assert.deepEqual(move(11, 'up', startX), {offset: 6, x: startX})
  // Up from the first line goes to the start of the text, and down from the last line to its end.
  assert.deepEqual([move(6, 'up').offset, move(15, 'down').offset], [0, 20])
  // Line start and line end stay on the caret's line: the end is before the space that hangs there.
  assert.deepEqual([move(5, 'lineStart').offset, move(5, 'lineEnd').offset], [0, 8])
  assert.deepEqual([move(10, 'lineStart').offset, move(10, 'lineEnd').offset], [9, 11])
  assert.deepEqual([move(15, 'lineStart').offset, move(15, 'lineEnd').offset], [12, 20])
  // A caret that isn't laid out, e.g. in a cell that the program doesn't hold: up and down go to the text's ends,
  // and line start and line end stay.
  const cut = (offset: number, direction: 'up' | 'down' | 'lineStart' | 'lineEnd') => offsetAfterLineMove(text, 2, offset, direction, null, layout, measure).offset
  assert.deepEqual([cut(15, 'up'), cut(15, 'down'), cut(15, 'lineStart'), cut(15, 'lineEnd')], [0, 20, 15, 15])
  // An empty note.
  const empty = prepare('')
  const emptyLayout: NotesLayout = {...layoutOfLines([], []), band: band => ({usable: band === 0, left: 24, width: 440})}
  assert.deepEqual(offsetAfterLineMove(empty, 0, 0, 'down', null, emptyLayout, measure), {offset: 0, x: 24})
})

test('a run of letters wider than the narrowest column is cut into pieces that fit the narrowest slot, and an ordinary long word stays whole', () => {
  // 21 letters, 154 px: wider than a slot, narrower than the limit.
  const word = 'incomprehensibilities'
  assert.ok(measure(word) > 80 && measure(word) < 230)
  assert.deepEqual(prepare(`an ${word} of`).cellTexts, ['an', ' ', word, ' ', 'of'])
  // 70 letters without a space, about 540 px.
  const run = 'qwertyuiopasdfghjklzxcvbnm'.repeat(3).slice(0, 70)
  assert.ok(measure(run) > 440)
  const text = prepare(`see ${run} end`)
  const pieces = text.cellTexts.slice(2, -2)
  assert.deepEqual([text.cellTexts.slice(0, 2), text.cellTexts.slice(-2)], [['see', ' '], [' ', 'end']])
  assert.equal(pieces.join(''), run)
  assert.ok(pieces.length >= 7 && pieces.length <= 9, `${pieces.length} pieces`)
  pieces.forEach((piece, index) => {
    const width = text.paragraph.widths[2 + index]!
    assert.equal(width, measure(piece))
    assert.ok(width <= 80, `piece ${piece} is ${width} px wide`)
    // Each piece but the last is as long as fits: one more letter would pass 80 px.
    if (index < pieces.length - 1) assert.ok(measure(piece + pieces[index + 1]![0]!) > 80)
  })
  assert.deepEqual(text.paragraph.breakAfter, [0, 1, ...pieces.map(() => 0), 1, 0])
  // The cells still spell the text, so a caret inside the run has its place in a piece.
  assert.equal(text.cellTexts.join(''), text.normalized)
  const fourth = caretCell(text, 4 + pieces[0]!.length + pieces[1]!.length + pieces[2]!.length + 2)!
  assert.deepEqual([fourth.cell, fourth.charactersBefore], [5, 2])
  // A letter and its combining accent stay in one piece, and so do the two halves of a surrogate pair.
  for (const cluster of ['e\u0301', '\u{1F600}']) {
    const clusters = cutIntoPieces(cluster.repeat(40), 30, measure)
    assert.ok(clusters.length > 1)
    assert.ok(clusters.every(piece => piece.text.length % cluster.length === 0 && piece.text === cluster.repeat(piece.text.length / cluster.length)))
  }
  // A letter wider than the piece width is a piece of its own.
  assert.deepEqual(cutIntoPieces('mmm', 1, measure).map(piece => piece.text), ['m', 'm', 'm'])
  assert.deepEqual(cutIntoPieces('', 80, measure), [])
})

test('the notice names each capacity that the text passes, in plain sentences', () => {
  const within = {segments: 89, capacity: 128, hiddenWords: 0, wrappedLines: 0, window: 40}
  assert.equal(notesNotice(within), '')
  assert.equal(notesNotice({...within, segments: 128}), '')
  assert.equal(notesNotice({...within, segments: 399}), 'This text has 399 words and spaces, and the note lays out the first 128.')
  assert.equal(notesNotice({...within, segments: 9091}), 'This text has 9,091 words and spaces, and the note lays out the first 128.')
  assert.equal(notesNotice({...within, hiddenWords: 10}), 'The last 10 words don\'t fit in the lines that are free.')
  assert.equal(notesNotice({...within, hiddenWords: 1}), 'The last word doesn\'t fit in the lines that are free.')
  assert.equal(notesNotice({...within, wrappedLines: 2}), 'A line holds 40 words and spaces at most, so 2 lines wrap early.')
  assert.equal(notesNotice({...within, wrappedLines: 1}), 'A line holds 40 words and spaces at most, so 1 line wraps early.')
  assert.equal(
    notesNotice({segments: 150, capacity: 128, hiddenWords: 3, wrappedLines: 1, window: 40}),
    'This text has 150 words and spaces, and the note lays out the first 128. The last 3 words don\'t fit in the lines that are free. A line holds 40 words and spaces at most, so 1 line wraps early.',
  )
})
