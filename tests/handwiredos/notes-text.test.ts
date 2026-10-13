// The host's helpers for a typed Notes text: the textarea value as segment cells,
// and the caret's place from the program's outputs.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {prepareWithSegments} from '@chenglou/pretext'
import {fakeTextWidth, testFont} from './fake-canvas.ts'
import {type NotesLayout, caretCell, caretPosition, normalizeNotesValue, prepareNotesText} from '../../src/handwiredos/notes-text.ts'

const measure = (text: string) => fakeTextWidth(text, testFont)
const prepare = (value: string) => prepareNotesText(value, testFont, measure)

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
  const text = prepareNotesText(' two  words here ', testFont, measure, () => {
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
