// The prepared width table, kept in JS. Each distinct grapheme gets a code the first time it
// appears, with its class and its advance measured once and rounded to layout units. The circuit
// only ever sees codes and packed table entries; adding a grapheme writes one more table cell.

import {classCodes, packCell} from './baseline-reference.ts'

export type MeasureText = (text: string) => number

export type WidthTable = {
  unitsPerPixel: number
  codeLimit: number
  // graphemes[code]; code 0 is the empty cell.
  graphemes: string[]
  // packed[code], the value the circuit's table cell holds.
  packed: number[]
  codeOf: (grapheme: string) => number | null
}

const wordCharacter = /^[\p{L}\p{N}\p{M}_']+$/u

// Only the ASCII space and the tab are in the space class: they hang past a line end and open a
// break opportunity after themselves. No-break spaces, e.g. U+00A0 and U+202F, fall through to the
// other class, so like any other glyph they count toward the line width and never open a break
// opportunity. Other break opportunities, e.g. between CJK ideographs, aren't modeled.
export function classifyGrapheme(grapheme: string): number {
  if (grapheme === '\n') return classCodes.newline
  if (grapheme === ' ' || grapheme === '\t') return classCodes.space
  return wordCharacter.test(grapheme) ? classCodes.word : classCodes.other
}

export function segmentGraphemes(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'})
  return Array.from(segmenter.segment(normalized), segment => segment.segment)
}

export function createWidthTable(codeLimit: number, unitsPerPixel: number, measure: MeasureText): WidthTable {
  const graphemes = ['']
  const packed = [0]
  const codes = new Map<string, number>()
  return {
    unitsPerPixel,
    codeLimit,
    graphemes,
    packed,
    codeOf: grapheme => {
      const existing = codes.get(grapheme)
      if (existing !== undefined) return existing
      if (graphemes.length >= codeLimit) return null
      const code = graphemes.length
      const classCode = classifyGrapheme(grapheme)
      const advance = classCode === classCodes.newline ? 0 : Math.min(1023, Math.max(0, Math.round(measure(grapheme) * unitsPerPixel)))
      graphemes.push(grapheme)
      packed.push(packCell(code, classCode, advance))
      codes.set(grapheme, code)
      return code
    },
  }
}

// Codes for a text, dropping graphemes once the table is full.
export function encodeText(table: WidthTable, text: string): number[] {
  const codes: number[] = []
  for (const grapheme of segmentGraphemes(text)) {
    const code = table.codeOf(grapheme)
    if (code !== null) codes.push(code)
  }
  return codes
}

export function decodeCells(table: WidthTable, cells: readonly number[], from: number, to: number): string {
  let text = ''
  for (let cell = from; cell < to; cell++) text += table.graphemes[Math.floor(cells[cell]! / 4096)] ?? ''
  return text
}
