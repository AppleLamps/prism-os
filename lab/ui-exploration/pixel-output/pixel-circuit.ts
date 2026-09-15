// The per-pixel program. It adds two source cells, pixelX and pixelY, to the thread
// circuit built with no slots, and computes one pixel's paint from the thread's
// per-row outputs. Nothing here reads a DOM slot: every pixel finds the row under
// it and reads that row's banner, comment box and gutter geometry.
//
// Two ways to find the row under the pixel:
// - 'count': [top_r <= y] for every row, the row index as their count, and a
//   one-hot as differences of neighboring bits, read through gathers. This is
//   what the shared runtime can do, and it costs about 5 operations per row per pixel.
// - 'binary-search': 8 index reads over the row tops (index-read's instruction),
//   then direct reads of the row's fields. Static per-row numbers live in source cells.
//
// Both produce the same outputs bit for bit on sorted row tops, since every field
// they read holds the same FP32 value and the arithmetic after the reads is identical.
import {Circuit, type Terms, type Wire} from '../index-read/numeric-ui-core.ts'
import {paintColors, paintGeometry, pixelOutputField, type PaintTables, type TextMode} from './pixel-model.ts'
import type {GlyphAtlas, TextCapacity, TextTables} from './text-table.ts'
import type {BuiltThreadCircuit} from './thread-circuit.ts'
import type {RowFrame} from './thread-frame.ts'
import {threadLayout, type ThreadTables} from '../hn-thread/thread-model.ts'

export type RowLookup = 'count' | 'binary-search'

export type PixelProgramOptions = {rowLookup: RowLookup, text: TextMode}

// Offsets inside the thread layout's extra cells. -1 when a table isn't used.
export type PixelCellLayout = {
  count: number
  pixelX: number
  pixelY: number
  indentWidth: number
  labelWidthExpanded: number
  labelWidthDelta: number
  gutterOwner: number
  // Glyph text only: per-row line ranges, per-line tops, starts and lengths, per-character codes and x, and the atlas.
  lineBase: number
  lineCount: number
  lineTop: number
  lineStart: number
  lineLength: number
  charCode: number
  charX: number
  atlas: number
  text: {capacity: TextCapacity, cellWidth: number, cellHeight: number, codes: number} | null
}

export type GlyphTextCells = {capacity: TextCapacity, atlas: GlyphAtlas}

export function pixelCellLayout(tables: ThreadTables, options: PixelProgramOptions, glyphText?: GlyphTextCells): PixelCellLayout {
  const rowCount = tables.rowCount
  const levels = tables.maxIndent + 1
  const noText = {lineBase: -1, lineCount: -1, lineTop: -1, lineStart: -1, lineLength: -1, charCode: -1, charX: -1, atlas: -1, text: null}
  if (options.rowLookup === 'count') {
    if (options.text !== 'bars') throw new Error('glyph text reads tables at computed indices, so it needs the binary-search lookup')
    return {count: 2, pixelX: 0, pixelY: 1, indentWidth: -1, labelWidthExpanded: -1, labelWidthDelta: -1, gutterOwner: -1, ...noText}
  }
  const barsCount = 2 + 3 * rowCount + rowCount * levels
  const layout = {pixelX: 0, pixelY: 1, indentWidth: 2, labelWidthExpanded: 2 + rowCount, labelWidthDelta: 2 + 2 * rowCount, gutterOwner: 2 + 3 * rowCount}
  if (options.text === 'bars') return {count: barsCount, ...layout, ...noText}
  if (glyphText === undefined) throw new Error('glyph text needs capacities and an atlas')
  const {capacity, atlas} = glyphText
  const codes = atlas.characters.length
  const lineBase = barsCount
  const lineCount = lineBase + rowCount
  const lineTop = lineCount + rowCount
  const lineStart = lineTop + capacity.lines
  const lineLength = lineStart + capacity.lines
  const charCode = lineLength + capacity.lines
  const charX = charCode + capacity.characters
  const atlasStart = charX + capacity.characters
  return {
    count: atlasStart + codes * atlas.cellHeight * atlas.cellWidth,
    ...layout,
    lineBase, lineCount, lineTop, lineStart, lineLength, charCode, charX, atlas: atlasStart,
    text: {capacity, cellWidth: atlas.cellWidth, cellHeight: atlas.cellHeight, codes},
  }
}

// The row whose gutter runs through column `level` next to `row`: hn.js's ancestor at that level, when its indent is
// exactly that level. Otherwise no gutter is at that column there, and the table holds rowCount, which reads zeros.
export function gutterOwner(tables: ThreadTables, row: number, level: number) {
  const ancestor = tables.ancestorAtLevel[row]![level]!
  return tables.indents[ancestor] === level ? ancestor : tables.rowCount
}

// Static tables: written once per thread.
export function writePixelTables(source: Float32Array, built: BuiltThreadCircuit, cells: PixelCellLayout, tables: ThreadTables, paint: PaintTables, atlas?: GlyphAtlas) {
  if (cells.indentWidth < 0) return
  const start = built.layout.extraStart
  const levels = tables.maxIndent + 1
  for (let row = 0; row < tables.rowCount; row++) {
    source[start + cells.indentWidth + row] = tables.indents[row]! * threadLayout.indentWidth
    source[start + cells.labelWidthExpanded + row] = paint.labelWidthExpanded[row]!
    source[start + cells.labelWidthDelta + row] = paint.labelWidthCollapsed[row]! - paint.labelWidthExpanded[row]!
    for (let level = 0; level < levels; level++) source[start + cells.gutterOwner + row * levels + level] = gutterOwner(tables, row, level)
  }
  if (cells.text === null) return
  if (atlas === undefined) throw new Error('glyph text needs its atlas written')
  source.set(atlas.bits, start + cells.atlas)
}

// What the per-pixel searches reach: 9 probes over a comment's lines, 8 over a line's characters.
export const maximumLinesPerComment = 511
export const maximumCharactersPerLine = 255

// Line and character tables: written when the container width changes.
export function writeTextTables(source: Float32Array, built: BuiltThreadCircuit, cells: PixelCellLayout, text: TextTables) {
  if (cells.text === null) throw new Error('this pixel program has no glyph text cells')
  const {capacity} = cells.text
  if (text.lineTop.length > capacity.lines) throw new Error(`${text.lineTop.length} lines exceed the capacity of ${capacity.lines}`)
  if (text.charCode.length > capacity.characters) throw new Error(`${text.charCode.length} characters exceed the capacity of ${capacity.characters}`)
  if (Math.max(...text.lineCount) > maximumLinesPerComment) throw new Error('a comment has more lines than the line search reaches')
  if (Math.max(...text.lineLength) > maximumCharactersPerLine) throw new Error('a line has more characters than the character search reaches')
  const start = built.layout.extraStart
  source.set(text.lineBase, start + cells.lineBase)
  source.set(text.lineCount, start + cells.lineCount)
  source.set(text.lineTop, start + cells.lineTop)
  source.set(text.lineStart, start + cells.lineStart)
  source.set(text.lineLength, start + cells.lineLength)
  source.set(text.charCode, start + cells.charCode)
  source.set(text.charX, start + cells.charX)
}

export type BuiltPixelProgram = {
  options: PixelProgramOptions
  cells: PixelCellLayout
  pixelXCell: Wire
  pixelYCell: Wire
  // pixelOutputField order: red, green, blue, layer, row, emphasis.
  outputs: Wire[]
  comparisons: number
  // Wires the float64 rasterizer reads when it takes geometry from the circuit.
  checkWires: Wire[]
}

export function buildPixelProgram(
  built: BuiltThreadCircuit,
  tables: ThreadTables,
  paint: PaintTables,
  options: PixelProgramOptions,
  cells: PixelCellLayout,
): BuiltPixelProgram {
  const {circuit, globalWires: global, rowWires, tops, layout} = built
  const rowCount = built.rowCount
  const levels = tables.maxIndent + 1
  const extra = layout.extraStart
  if (layout.extraCount !== cells.count) throw new Error('thread circuit was built with the wrong number of extra cells')
  const pixelX = extra + cells.pixelX
  const pixelY = extra + cells.pixelY
  circuit.assumeRange(pixelX, -16384, 16384)
  circuit.assumeRange(pixelY, -16384, 16384)
  if (cells.indentWidth >= 0) {
    for (let row = 0; row < rowCount; row++) {
      circuit.assumeRange(extra + cells.indentWidth + row, 0, 24 * tables.maxIndent)
      circuit.assumeRange(extra + cells.labelWidthExpanded + row, 0, 8192)
      circuit.assumeRange(extra + cells.labelWidthDelta + row, 0, 8192)
      for (let level = 0; level < levels; level++) circuit.assumeRange(extra + cells.gutterOwner + row * levels + level, 0, rowCount)
    }
  }
  if (cells.text !== null) {
    const {capacity, codes, cellWidth, cellHeight} = cells.text
    for (let row = 0; row < rowCount; row++) {
      circuit.assumeRange(extra + cells.lineBase + row, 0, capacity.lines)
      circuit.assumeRange(extra + cells.lineCount + row, 0, maximumLinesPerComment)
    }
    for (let line = 0; line < capacity.lines; line++) {
      circuit.assumeRange(extra + cells.lineTop + line, 0, 8192)
      circuit.assumeRange(extra + cells.lineStart + line, 0, capacity.characters)
      circuit.assumeRange(extra + cells.lineLength + line, 0, maximumCharactersPerLine)
    }
    for (let character = 0; character < capacity.characters; character++) {
      circuit.assumeRange(extra + cells.charCode + character, 0, codes - 1)
      circuit.assumeRange(extra + cells.charX + character, 0, 8192)
    }
    for (let index = 0; index < codes * cellHeight * cellWidth; index++) circuit.assumeRange(extra + cells.atlas + index, 0, 1)
  }
  const firstWire = circuit.sourceSize + circuit.operations.length
  const rows = Array.from({length: rowCount}, (_, row) => row)

  const term = (wire: Wire, coefficient = 1): [Wire, number] => [wire, coefficient]
  const affine = (terms: Terms, bias = 0) => circuit.affine(terms, bias)
  const round = (terms: Terms, bias = 0) => circuit.roundAffine(terms, bias)
  const relu = (terms: Terms, bias = 0) => circuit.reglu([], 1, terms, bias)
  const multiply = (left: Wire, right: Wire) => circuit.multiply(left, right)
  const and = (...bits: Wire[]) => relu(bits.map(bit => term(bit)), 1 - bits.length)
  let comparisons = 0
  const bitFromScore = (score: Wire) => {
    const clamped = affine([term(relu([term(score)])), term(relu([term(score)], -1), -1)])
    circuit.assumeRange(clamped, 0, 1)
    comparisons++
    return circuit.boolean(clamped)
  }
  // Same comparison construction as thread-circuit.ts: a power-of-two scale with scale * bound <= 2^22.
  const scaleFor = (bound: number) => {
    let scale = 2 ** 16
    while (scale * bound > 2 ** 22) scale /= 2
    return scale
  }
  // [terms + bias >= 0]
  const atLeast = (terms: Terms, bias: number, bound: number) => {
    const scale = scaleFor(bound)
    return bitFromScore(round(terms.map(([wire, coefficient]) => term(wire, coefficient * scale)), bias * scale + 0.5))
  }
  // [terms + bias > 0]
  const above = (terms: Terms, bias: number, bound: number) => {
    const scale = scaleFor(bound)
    return bitFromScore(round(terms.map(([wire, coefficient]) => term(wire, coefficient * scale)), bias * scale))
  }
  const zero = round([], 0)
  // FP32 steps are exactly 1 in [2^23, 2^24): adding and removing this base rounds to the nearest integer.
  const roundingBase = 2 ** 23 + 2 ** 22
  const roundToInteger = (value: Wire) => round([term(round([term(value)], roundingBase))], -roundingBase)
  const clampZeroOne = (value: Wire) => {
    const clamped = affine([term(relu([term(value)])), term(relu([term(value)], -1), -1)])
    circuit.assumeRange(clamped, 0, 1)
    return clamped
  }

  const xBound = 32768
  const yBound = 65536
  const containerTop = threadLayout.currentContainerTop
  const geometry = paintGeometry

  // Container coordinates: x from the container's left edge, y from the scroller's top edge.
  const localX = round([term(pixelX), term(global.containerLeft, -1)])
  const localY = round([term(pixelY), term(global.scrollerTop, -1)], -containerTop)

  // The white container with rounded corners: a pixel center is inside a corner when dx² + dy² <= radius².
  const radius = geometry.cornerRadius
  const inX = and(atLeast([term(localX)], 0, xBound), above([term(global.containerWidth), term(localX, -1)], 0, xBound))
  const inY = and(atLeast([term(pixelY)], -containerTop, xBound), above([term(global.containerHeight), term(pixelY, -1)], containerTop, xBound))
  const cornerX = affine([term(relu([term(localX, -1)], radius)), term(relu([term(localX), term(global.containerWidth, -1)], radius))])
  const cornerY = affine([term(relu([term(pixelY, -1)], containerTop + radius)), term(relu([term(pixelY), term(global.containerHeight, -1)], radius - containerTop))])
  const cornerInside = atLeast([term(multiply(cornerX, cornerX), -1), term(multiply(cornerY, cornerY), -1)], radius * radius, 512)
  const inContainer = and(inX, inY, cornerInside)
  const inScroller = and(inContainer, atLeast([term(localY)], 0, yBound), above([term(global.scrollerHeight), term(localY, -1)], 0, yBound))

  // Submission header: one gray bar per line, above the scroller.
  const headerRegion = and(inContainer, above([term(localY, -1)], 0, yBound))
  const headerLine = (lineTop: Wire, left: number, width: number, inkTop: number, inkBottom: number) => and(
    atLeast([term(pixelY), term(lineTop, -1)], -(containerTop + inkTop), yBound),
    above([term(lineTop), term(pixelY, -1)], containerTop + inkBottom, yBound),
    atLeast([term(localX)], -left, xBound),
    above([term(localX, -1)], left + width, xBound),
  )
  const line1 = headerLine(global.submissionLine1Top, geometry.headerLine1Left, paint.headerLine1Width, geometry.headerLine1InkTop, geometry.headerLine1InkBottom)
  const line2 = headerLine(global.submissionLine2Top, geometry.headerLine2Left, paint.headerLine2Width, geometry.headerLine2InkTop, geometry.headerLine2InkBottom)
  const headerInk = relu([term(headerRegion), term(line1), term(line2)], -1)

  type RowAccess = {
    // -1 above the first row; rowCount - 1 or more below the last row's top.
    rowIndex: Wire
    rowOutput: Wire
    read: (values: readonly Wire[]) => Wire
    readStatic: (values: readonly number[], cellOffset: number) => Wire
  }
  const field = (name: keyof RowFrame) => rowWires.map(row => row[name])

  let access: RowAccess
  let gutter: {top: Wire, bottom: Wire, visible: Wire, emphasis: Wire, levelZero: Wire}
  if (options.rowLookup === 'count') {
    const bits = rows.map(row => atLeast([term(localY), term(tops[row]!, -1)], 0, yBound))
    const members = rows.map(row => row === rowCount - 1 ? bits[row]! : affine([term(bits[row]!), term(bits[row + 1]!, -1)]))
    circuit.assumeOneHot(members, true)
    const rowIndex = affine(bits.map(bit => term(bit)), -1)
    const read = (values: readonly Wire[]) => affine(members.map((member, row) => term(multiply(member, values[row]!))))
    access = {
      rowIndex,
      rowOutput: rowIndex,
      read,
      readStatic: values => affine(members.map((member, row) => term(member, values[row]!))),
    }
    // Gutters: one column bit per indent level, and per level the gutter owner's fields read through the row one-hot.
    const onColumn = Array.from({length: levels}, (_, level) => and(
      atLeast([term(localX)], -threadLayout.indentWidth * level, xBound),
      above([term(localX, -1)], threadLayout.indentWidth * level + geometry.gutterWidth, xBound),
    ))
    circuit.assumeOneHot(onColumn, true)
    const levelRead = (name: keyof RowFrame) => {
      const perLevel = Array.from({length: levels}, (_, level) => read(rows.map(row => {
        const owner = gutterOwner(tables, row, level)
        return owner === rowCount ? zero : rowWires[owner]![name]
      })))
      return affine(onColumn.map((bit, level) => term(multiply(bit, perLevel[level]!))))
    }
    gutter = {top: levelRead('gutterTop'), bottom: levelRead('gutterBottom'), visible: levelRead('gutterVisible'), emphasis: levelRead('gutterEmphasis'), levelZero: onColumn[0]!}
  } else {
    // Largest i with tops[i] <= y, by 8 probes. Probes past the table clamp to tops[rowCount], the end of the last row.
    const firstBit = atLeast([term(localY), term(tops[0]!, -1)], 0, yBound)
    let low: Wire = zero
    for (const step of [128, 64, 32, 16, 8, 4, 2, 1]) {
      const probe = circuit.indexReadAffine([term(low)], step, tops, 'clamp', 'clamp')
      const bit = atLeast([term(localY), term(probe, -1)], 0, yBound)
      low = affine([term(low), term(bit, step)])
    }
    if (rowCount > 256) throw new Error('the binary search covers 256 rows')
    const rowIndex = affine([term(low), term(firstBit)], -1)
    const cellWires = (offset: number, count: number) => Array.from({length: count}, (_, index) => extra + offset + index)
    access = {
      rowIndex,
      rowOutput: affine([term(rowIndex), term(relu([term(rowIndex)], -(rowCount - 1)), -1)]),
      read: values => circuit.indexRead(rowIndex, values, {outOfRange: 'clamp'}),
      readStatic: (_, cellOffset) => circuit.indexRead(rowIndex, cellWires(cellOffset, rowCount), {outOfRange: 'clamp'}),
    }
    // Gutters: the indent level under the pointer as a count, the owner from a table at (row, level), then its fields.
    const levelBits = Array.from({length: tables.maxIndent}, (_, index) => atLeast([term(localX)], -threadLayout.indentWidth * (index + 1), xBound))
    const level = affine(levelBits.map(bit => term(bit)))
    // [localX >= 0] and [24 * level + 1 - localX > 0]
    const onColumn = and(atLeast([term(localX)], 0, xBound), above([term(localX, -1), term(level, threadLayout.indentWidth)], geometry.gutterWidth, xBound))
    const owner = circuit.indexReadAffine([term(rowIndex, levels), term(level)], 0, cellWires(cells.gutterOwner, rowCount * levels), 'clamp', 'clamp')
    const ownerRead = (name: keyof RowFrame) => circuit.indexRead(owner, [...field(name), zero], {outOfRange: 'clamp'})
    gutter = {
      top: ownerRead('gutterTop'),
      bottom: ownerRead('gutterBottom'),
      visible: and(ownerRead('gutterVisible'), onColumn),
      emphasis: ownerRead('gutterEmphasis'),
      levelZero: levelBits.length === 0 ? circuit.affine([], 1) : affine([term(levelBits[0]!, -1)], 1),
    }
  }

  const staticIndentWidth = tables.indents.map(indent => indent * threadLayout.indentWidth)
  const indentWidth = access.readStatic(staticIndentWidth, cells.indentWidth)

  // The sticky user banner of the row under the pixel, and its label as one gray bar.
  const bannerTop = access.read(field('userTop'))
  const bannerHeight = access.read(field('userHeight'))
  const emphasis = access.read(field('emphasis'))
  const collapsed = access.read(field('collapsed'))
  const bannerOpacity = access.read(field('userOpacity'))
  const labelOpacity = access.read(field('userTextOpacity'))
  const onBanner = and(
    inScroller,
    atLeast([term(localY), term(bannerTop, -1)], 0, yBound),
    above([term(bannerTop), term(bannerHeight), term(localY, -1)], 0, yBound),
    atLeast([term(localX), term(indentWidth, -1)], 0, xBound),
  )
  const labelWidth = round([
    term(access.readStatic(paint.labelWidthExpanded, cells.labelWidthExpanded)),
    term(multiply(collapsed, access.readStatic(paint.labelWidthCollapsed.map((width, row) => width - paint.labelWidthExpanded[row]!), cells.labelWidthDelta))),
  ])
  const bannerInk = and(
    onBanner,
    atLeast([term(localY), term(bannerTop, -1), term(bannerHeight, -0.5)], geometry.labelHalfHeight, yBound),
    above([term(bannerTop), term(bannerHeight, 0.5), term(localY, -1)], geometry.labelHalfHeight, yBound),
    atLeast([term(localX), term(indentWidth, -1)], -geometry.labelLeft, xBound),
    above([term(indentWidth), term(labelWidth), term(localX, -1)], geometry.labelLeft, xBound),
  )

  // Glyph text: the line under the pixel by a binary search over this comment's line tops, the character by a binary
  // search over that line's character x positions, then one atlas read at (code, glyph row, glyph column).
  const glyphInkBits = (yText: Wire): Wire[] => {
    const text = cells.text
    if (text === null || options.rowLookup !== 'binary-search') throw new Error('glyph text needs text cells and the binary-search lookup')
    const cellsOf = (offset: number, count: number) => Array.from({length: count}, (_, index) => extra + offset + index)
    const lineTopCells = cellsOf(cells.lineTop, text.capacity.lines)
    const charXCells = cellsOf(cells.charX, text.capacity.characters)
    // Largest k in 0..count - 1 with table[base + k] <= target. Probes read min(low + step, count - 1), so they never
    // leave this comment's lines or this line's characters.
    const search = (base: Wire, count: Wire, steps: readonly number[], table: readonly Wire[], target: Wire, bound: number) => {
      let low: Wire = zero
      for (const step of steps) {
        const excess = relu([term(low), term(count, -1)], step + 1)
        const probe = circuit.indexReadAffine([term(base), term(low), term(excess, -1)], step, table, 'clamp', 'clamp')
        low = affine([term(low), term(atLeast([term(target), term(probe, -1)], 0, bound), step)])
      }
      return affine([term(low), term(relu([term(low), term(count, -1)], 1), -1)])
    }
    const readAt = (index: Wire, offset: number, count: number) => circuit.indexRead(index, cellsOf(offset, count), {outOfRange: 'clamp'})
    const lineBase = access.readStatic([], cells.lineBase)
    const lineCount = access.readStatic([], cells.lineCount)
    const lineIndex = affine([term(lineBase), term(search(lineBase, lineCount, [256, 128, 64, 32, 16, 8, 4, 2, 1], lineTopCells, yText, yBound))])
    const yLine = round([term(yText), term(readAt(lineIndex, cells.lineTop, text.capacity.lines), -1)])
    const lineStart = readAt(lineIndex, cells.lineStart, text.capacity.lines)
    const lineLength = readAt(lineIndex, cells.lineLength, text.capacity.lines)
    const xText = round([term(localX), term(indentWidth, -1)], -threadLayout.commentLeftGap)
    const charIndex = affine([term(lineStart), term(search(lineStart, lineLength, [128, 64, 32, 16, 8, 4, 2, 1], charXCells, xText, xBound))])
    const code = readAt(charIndex, cells.charCode, text.capacity.characters)
    const xGlyph = round([term(xText), term(readAt(charIndex, cells.charX, text.capacity.characters), -1)])
    // floor(t) = round(t) - [round(t) > t]
    const floorOf = (value: Wire) => {
      const rounded = roundToInteger(value)
      return affine([term(rounded), term(above([term(rounded), term(value, -1)], 0, 64), -1)])
    }
    const atlasCells = cellsOf(cells.atlas, text.codes * text.cellHeight * text.cellWidth)
    const bit = circuit.indexReadAffine([term(code, text.cellHeight * text.cellWidth), term(floorOf(yLine), text.cellWidth), term(floorOf(xGlyph))], 0, atlasCells, 'clamp', 'clamp')
    const atLeastOne = (count: Wire) => affine([term(relu([term(count)])), term(relu([term(count)], -1), -1)])
    return [
      atLeastOne(lineCount),
      atLeastOne(lineLength),
      atLeast([term(xGlyph)], 0, 64),
      above([term(xGlyph, -1)], text.cellWidth, 64),
      atLeast([term(yLine)], 0, 64),
      above([term(yLine, -1)], text.cellHeight, 64),
      bit,
    ]
  }

  // Comment text inside the comment box and the text height: one gray bar per 14px line, or glyphs.
  const commentTop = access.read(field('commentTop'))
  const commentHeight = access.read(field('commentHeight'))
  const textHeight = access.read(field('textHeight'))
  const yText = round([term(localY), term(commentTop, -1)])
  const commentBox = [
    inScroller,
    atLeast([term(yText)], 0, yBound),
    above([term(commentHeight), term(yText, -1)], 0, yBound),
    above([term(textHeight), term(yText, -1)], 0, yBound),
    atLeast([term(localX), term(indentWidth, -1)], -threadLayout.commentLeftGap, xBound),
    above([term(global.containerWidth), term(localX, -1)], -threadLayout.commentRightGap, xBound),
  ]
  let commentInk: Wire
  if (options.text === 'bars') {
    const lineIndex = roundToInteger(round([term(yText, 1 / geometry.linePitch)], -0.5))
    const yInLine = round([term(yText), term(lineIndex, -geometry.linePitch)])
    commentInk = and(...commentBox, atLeast([term(yInLine)], -geometry.barTop, 16), above([term(yInLine, -1)], geometry.barBottom, 16))
  } else {
    commentInk = and(...commentBox, ...glyphInkBits(yText))
  }

  // Gutter lines, drawn above everything. Level-0 lines stop 8px above the container's bottom edge.
  const belowBottom = above([term(global.containerHeight), term(pixelY, -1)], containerTop, xBound)
  const belowInset = above([term(global.containerHeight), term(pixelY, -1)], containerTop - geometry.levelZeroGutterInset, xBound)
  const clip = affine([term(belowBottom), term(relu([term(gutter.levelZero), term(belowBottom), term(belowInset, -1)], -1), -1)])
  const onGutter = and(
    gutter.visible,
    atLeast([term(localY), term(gutter.top, -1)], 0, yBound),
    above([term(gutter.bottom), term(localY, -1)], 0, yBound),
    clip,
  )
  const gutterEmphasis = and(onGutter, gutter.emphasis)

  // Topmost paint layer, emphasis, row, and color.
  const commentVisible = relu([term(commentInk), term(onBanner, -1)])
  const layerBeforeGutter = affine([term(inContainer), term(headerInk), term(inScroller, 2), term(commentVisible), term(onBanner, 2), term(bannerInk)])
  const layer = round([term(layerBeforeGutter), term(multiply(onGutter, affine([term(layerBeforeGutter, -1)], 7)))])
  const emphasisOutput = affine([term(relu([term(onBanner), term(emphasis), term(onGutter, -1)], -1)), term(gutterEmphasis)])
  const rowOutput = round([term(multiply(inScroller, affine([term(access.rowOutput)], 1)))], -1)
  const colors = paintColors
  const commentColor = options.text === 'bars' ? colors.commentBar : colors.commentGlyph
  const bannerAlpha = multiply(onBanner, bannerOpacity)
  const bannerEmphasisAlpha = multiply(emphasis, bannerAlpha)
  const inkAlpha = multiply(bannerInk, multiply(clampZeroOne(labelOpacity), bannerOpacity))
  const channels = [0, 1, 2].map(channel => {
    const base = affine([
      term(inContainer, colors.container[channel]! - colors.page[channel]!),
      term(headerInk, colors.headerInk[channel]! - colors.container[channel]!),
      term(inScroller, colors.display[channel]! - colors.container[channel]!),
      term(commentVisible, commentColor[channel]! - colors.display[channel]!),
      term(bannerAlpha, colors.emphasisNone[channel]! - colors.display[channel]!),
      term(bannerEmphasisAlpha, colors.emphasis[channel]! - colors.emphasisNone[channel]!),
    ], colors.page[channel]!)
    const withInk = round([term(base), term(multiply(inkAlpha, affine([term(base, -1)], colors.bannerInk[channel]!)))])
    const gutterColor = affine([term(gutterEmphasis, colors.emphasis[channel]! - colors.emphasisNone[channel]!)], colors.emphasisNone[channel]!)
    return round([term(withInk), term(multiply(onGutter, affine([term(gutterColor), term(withInk, -1)])))])
  })

  const outputs = Array<Wire>(pixelOutputField.size)
  outputs[pixelOutputField.red] = channels[0]!
  outputs[pixelOutputField.green] = channels[1]!
  outputs[pixelOutputField.blue] = channels[2]!
  outputs[pixelOutputField.layer] = layer
  outputs[pixelOutputField.row] = rowOutput
  outputs[pixelOutputField.emphasis] = emphasisOutput
  built.sections.push({name: 'per-pixel program', firstWire, endWire: circuit.sourceSize + circuit.operations.length})
  const checkWires = [
    global.containerLeft, global.containerWidth, global.containerHeight, global.scrollerTop, global.scrollerHeight,
    global.submissionLine1Top, global.submissionLine2Top, ...tops,
    ...(['userTop', 'userHeight', 'userOpacity', 'userTextOpacity', 'commentTop', 'commentHeight', 'textHeight', 'emphasis', 'collapsed', 'gutterTop', 'gutterBottom', 'gutterVisible', 'gutterEmphasis'] as const).flatMap(name => field(name)),
  ]
  return {options, cells, pixelXCell: pixelX, pixelYCell: pixelY, outputs, comparisons, checkWires}
}

export type {Circuit}
