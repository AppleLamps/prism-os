// Projects circuit outputs onto a view model the DOM layer draws: one absolutely positioned span
// per glyph, a caret rectangle, and one selection rectangle per line. The only arithmetic here is
// converting layout units to pixels and multiplying line indices by the line height.

import type {EditorFrame} from './editor-circuit.ts'
import {unpackCell} from './reference.ts'
import {decodeCells, type WidthTable} from './width-table.ts'

export type GlyphView = {cell: number, text: string, left: number, top: number, width: number}
export type RectangleView = {left: number, top: number, width: number, height: number}

export type EditorView = {
  glyphs: GlyphView[]
  caret: RectangleView
  selections: RectangleView[]
  lineCount: number
  overflow: boolean
  text: string
}

export function projectFrame(table: WidthTable, frame: EditorFrame, lineHeightUnits: number): EditorView {
  const {state, display} = frame
  const toPixels = (units: number) => units / table.unitsPerPixel
  const lineHeight = toPixels(lineHeightUnits)
  const glyphs: GlyphView[] = []
  for (let cell = 0; cell < state.length && cell < display.glyphX.length; cell++) {
    const {code, advance} = unpackCell(state.cells[cell]!)
    const grapheme = table.graphemes[code] ?? ''
    glyphs.push({
      cell,
      text: grapheme === '\n' ? '' : grapheme,
      left: toPixels(display.glyphX[cell]!),
      top: display.glyphLine[cell]! * lineHeight,
      width: toPixels(advance),
    })
  }
  const selections: RectangleView[] = []
  for (let line = 0; line < display.lineCount; line++) {
    const left = display.selectionLeft[line]!
    const right = display.selectionRight[line]!
    if (right > left) selections.push({left: toPixels(left), top: line * lineHeight, width: toPixels(right - left), height: lineHeight})
  }
  return {
    glyphs,
    caret: {left: toPixels(display.caretX), top: display.caretLine * lineHeight, width: 1.5, height: lineHeight},
    selections,
    lineCount: display.lineCount,
    overflow: display.overflowCount > 0,
    text: decodeCells(table, state.cells, 0, state.length),
  }
}

export function selectedText(table: WidthTable, frame: EditorFrame): string {
  const {state} = frame
  return decodeCells(table, state.cells, Math.min(state.anchor, state.caret), Math.max(state.anchor, state.caret))
}
