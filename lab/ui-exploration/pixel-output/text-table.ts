// Tables for drawing comment text per pixel: a 1-bit glyph atlas, and pretext's
// lines at the current container width as source cells.
//
// JS lays the comments out with pretext only when the container width changes (the
// vibescript port does the same on resize). The circuit keeps computing heights from
// breakpoints; `layoutTextTables` checks that its lines add up to the same heights.
// Per comment the tables hold its lines in order; per line its top (comment
// coordinates), its first character and its length; per character a glyph code and
// its x (line coordinates, quantized to 1/64px). Characters are laid out one at a
// time with `measure`, so glyphs sit where the additive measurement puts them; with
// the fake canvas every segment width is exactly the sum of its characters.
import {layoutWithLines} from './pretext/layout.ts'
import {materializeRichInlineLineRange, walkRichInlineLineRanges} from './pretext/rich-inline.ts'
import {commentBlockGap, commentBodyFont, commentCodeFont, commentItalicFont, commentLineHeight, commentWidthAt} from './text-heights.ts'
import type {MeasureText} from './pixel-model.ts'
import type {PreparedThread} from './thread-prepare.ts'

export type GlyphAtlas = {
  cellWidth: number
  cellHeight: number
  characters: string[]
  codeOf: Map<string, number>
  fallbackCode: number
  // codes × cellHeight × cellWidth bits, row first.
  bits: Uint8Array
}

export type GlyphAtlasJson = {cellWidth: number, cellHeight: number, glyphs: Record<string, string[]>}

export function atlasFromJson(json: GlyphAtlasJson, fallback = '?'): GlyphAtlas {
  const characters = Object.keys(json.glyphs).sort()
  const bits = new Uint8Array(characters.length * json.cellHeight * json.cellWidth)
  characters.forEach((character, code) => {
    json.glyphs[character]!.forEach((row, y) => {
      for (let x = 0; x < json.cellWidth; x++) bits[(code * json.cellHeight + y) * json.cellWidth + x] = row[x] === '1' ? 1 : 0
    })
  })
  const codeOf = new Map(characters.map((character, code) => [character, code]))
  return {cellWidth: json.cellWidth, cellHeight: json.cellHeight, characters, codeOf, fallbackCode: codeOf.get(fallback) ?? 0, bits}
}

export type TextTables = {
  containerWidth: number
  lineBase: number[]
  lineCount: number[]
  lineTop: number[]
  lineStart: number[]
  lineLength: number[]
  charCode: number[]
  charX: number[]
  // Characters with no glyph in the atlas, drawn with the fallback glyph.
  missingCharacters: number
}

export type TextCapacity = {lines: number, characters: number}

const quantize = (value: number) => Math.round(value * 64) / 64

export function layoutTextTables(prepared: PreparedThread, containerWidth: number, atlas: GlyphAtlas, measure: MeasureText): TextTables {
  const tables: TextTables = {containerWidth, lineBase: [], lineCount: [], lineTop: [], lineStart: [], lineLength: [], charCode: [], charX: [], missingCharacters: 0}
  const pushLine = (top: number, fragments: {gapBefore: number, text: string, font: string}[]) => {
    tables.lineTop.push(top)
    const start = tables.charCode.length
    tables.lineStart.push(start)
    let x = 0
    for (const fragment of fragments) {
      x += fragment.gapBefore
      for (const character of fragment.text) {
        const code = atlas.codeOf.get(character)
        if (code === undefined) tables.missingCharacters++
        tables.charCode.push(code ?? atlas.fallbackCode)
        tables.charX.push(quantize(x))
        x += measure(character, fragment.font)
      }
    }
    tables.lineLength.push(tables.charCode.length - start)
  }
  for (let row = 0; row < prepared.tables.rowCount; row++) {
    const commentWidth = Math.max(1, commentWidthAt(containerWidth, prepared.tables.indents[row]!))
    const blocks = prepared.preparedComments[row]!.blocks
    const docBlocks = prepared.docs[row]!.blocks
    tables.lineBase.push(tables.lineTop.length)
    let y = 0
    blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) y += commentBlockGap
      const docBlock = docBlocks[blockIndex]!
      if (block.kind === 'paragraph') {
        const runs = docBlock.kind === 'paragraph' ? docBlock.runs : []
        walkRichInlineLineRanges(block.flow, commentWidth, range => {
          const line = materializeRichInlineLineRange(block.flow, range)
          pushLine(y, line.fragments.map(fragment => ({
            gapBefore: fragment.gapBefore,
            text: fragment.text,
            font: runs[fragment.itemIndex]?.kind === 'italic' ? commentItalicFont : commentBodyFont,
          })))
          y += commentLineHeight
        })
      } else {
        for (const line of layoutWithLines(block.prepared, commentWidth, commentLineHeight).lines) {
          pushLine(y, [{gapBefore: 0, text: line.text, font: commentCodeFont}])
          y += commentLineHeight
        }
      }
    })
    tables.lineCount.push(tables.lineTop.length - tables.lineBase[row]!)
    const expected = prepared.textHeightAt(row, commentWidthAt(containerWidth, prepared.tables.indents[row]!))
    if (y !== expected) throw new Error(`comment ${row} at container width ${containerWidth}: lines add up to ${y}px, pretext's height is ${expected}px`)
  }
  return tables
}

// Capacities for the source table: the most lines and characters over a few widths, plus headroom.
export function textCapacity(prepared: PreparedThread, atlas: GlyphAtlas, measure: MeasureText): TextCapacity {
  let lines = 0
  let characters = 0
  for (const width of [375, 376, 500, 800, 1200]) {
    const tables = layoutTextTables(prepared, width, atlas, measure)
    lines = Math.max(lines, tables.lineTop.length)
    characters = Math.max(characters, tables.charCode.length)
  }
  return {lines: Math.ceil(lines * 1.05) + 64, characters: Math.ceil(characters * 1.02) + 256}
}
