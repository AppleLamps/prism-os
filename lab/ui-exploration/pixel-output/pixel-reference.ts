// A float64 rasterizer of the same picture, written as a painter's algorithm over
// rectangle lists instead of per-pixel arithmetic: the container, header bars, the
// scroller, then for every row in order its text bars, banner and label, then every
// visible gutter. Later rectangles paint over earlier ones. The row under a pixel
// is (the number of row tops at or above it) - 1, found per scanline.
//
// It takes its geometry either from thread-frame.ts's float64 reference frame
// (checking the whole pipeline) or from the circuit's own FP32 per-row values
// (checking only the per-pixel program).
//
// Pixel centers sit at offset + stride * i on both axes. A pixel is ambiguous when
// its center is within `band` px of an edge of a painted rectangle, a corner arc,
// or a row top; decisions there may legitimately differ.
import {paintColors, paintGeometry, paintLayer, type Color, type PaintTables, type TextMode} from './pixel-model.ts'
import type {GlyphAtlas, TextTables} from './text-table.ts'
import type {ThreadFrame} from './thread-frame.ts'
import {threadLayout, type ThreadTables} from '../hn-thread/thread-model.ts'

export type RowGeometry = {
  top: number
  bottom: number
  userTop: number
  userHeight: number
  userOpacity: number
  userTextOpacity: number
  commentTop: number
  commentHeight: number
  textHeight: number
  emphasis: number
  collapsed: number
  gutterTop: number
  gutterBottom: number
  gutterVisible: number
  gutterEmphasis: number
}

export type FrameGeometry = {
  containerLeft: number
  containerWidth: number
  containerHeight: number
  scrollerTop: number
  scrollerHeight: number
  line1Top: number
  line2Top: number
  rows: RowGeometry[]
}

export function geometryFromReference(frame: ThreadFrame): FrameGeometry {
  const global = frame.global
  return {
    containerLeft: global.containerLeft,
    containerWidth: global.containerWidth,
    containerHeight: global.containerHeight,
    scrollerTop: global.scrollerTop,
    scrollerHeight: global.scrollerHeight,
    line1Top: global.submissionLine1Top,
    line2Top: global.submissionLine2Top,
    rows: frame.rows.map(row => ({
      top: row.top,
      bottom: row.top + row.height,
      userTop: row.userTop,
      userHeight: row.userHeight,
      userOpacity: row.userOpacity,
      userTextOpacity: row.userTextOpacity,
      commentTop: row.commentTop,
      commentHeight: row.commentHeight,
      textHeight: row.textHeight,
      emphasis: row.emphasis,
      collapsed: row.collapsed,
      gutterTop: row.gutterTop,
      gutterBottom: row.gutterBottom,
      gutterVisible: row.gutterVisible,
      gutterEmphasis: row.gutterEmphasis,
    })),
  }
}

// checkWires order from pixel-circuit.ts: 7 globals, rowCount + 1 tops, then 13 per-row fields of rowCount entries.
export function geometryFromCheckValues(values: ArrayLike<number>, rowCount: number): FrameGeometry {
  const fields = ['userTop', 'userHeight', 'userOpacity', 'userTextOpacity', 'commentTop', 'commentHeight', 'textHeight', 'emphasis', 'collapsed', 'gutterTop', 'gutterBottom', 'gutterVisible', 'gutterEmphasis'] as const
  const topsStart = 7
  const fieldsStart = topsStart + rowCount + 1
  const rows: RowGeometry[] = []
  for (let row = 0; row < rowCount; row++) {
    const record = {top: values[topsStart + row]!, bottom: values[topsStart + row + 1]!} as RowGeometry
    fields.forEach((name, index) => {
      record[name] = values[fieldsStart + index * rowCount + row]!
    })
    rows.push(record)
  }
  return {
    containerLeft: values[0]!,
    containerWidth: values[1]!,
    containerHeight: values[2]!,
    scrollerTop: values[3]!,
    scrollerHeight: values[4]!,
    line1Top: values[5]!,
    line2Top: values[6]!,
    rows,
  }
}

export function topsSorted(geometry: FrameGeometry) {
  return geometry.rows.every(row => row.bottom >= row.top)
}

export type SampleGrid = {width: number, height: number, stride: number, offset: number}

export type Raster = {
  grid: SampleGrid
  layer: Int8Array
  row: Int16Array
  emphasis: Uint8Array
  red: Float64Array
  green: Float64Array
  blue: Float64Array
  ambiguous: Uint8Array
}

// glyphs: with text 'glyphs', the line and character tables at this frame's container width, and the atlas.
export function rasterize(
  geometry: FrameGeometry,
  tables: ThreadTables,
  paint: PaintTables,
  text: TextMode,
  grid: SampleGrid,
  band: number,
  glyphs?: {tables: TextTables, atlas: GlyphAtlas},
): Raster {
  const {width, height, stride, offset} = grid
  const count = width * height
  const raster: Raster = {
    grid,
    layer: new Int8Array(count),
    row: new Int16Array(count).fill(-1),
    emphasis: new Uint8Array(count),
    red: new Float64Array(count).fill(paintColors.page[0]),
    green: new Float64Array(count).fill(paintColors.page[1]),
    blue: new Float64Array(count).fill(paintColors.page[2]),
    ambiguous: new Uint8Array(count),
  }
  const inContainer = new Uint8Array(count)
  const inScroller = new Uint8Array(count)
  const top = threadLayout.currentContainerTop
  const left = geometry.containerLeft
  const scrollerPageTop = top + geometry.scrollerTop
  // Sample indices whose centers c satisfy low <= c < high.
  const span = (low: number, high: number, size: number): [number, number] => [
    Math.min(size, Math.max(0, Math.ceil((low - offset) / stride))),
    Math.min(size, Math.max(0, Math.ceil((high - offset) / stride))),
  ]
  const markRect = (x0: number, x1: number, y0: number, y1: number) => {
    if (!(x0 < x1 && y0 < y1)) return
    const strips: [number, number, number, number][] = [
      [x0 - band, x1 + band, y0 - band, y0 + band],
      [x0 - band, x1 + band, y1 - band, y1 + band],
      [x0 - band, x0 + band, y0 - band, y1 + band],
      [x1 - band, x1 + band, y0 - band, y1 + band],
    ]
    for (const [sx0, sx1, sy0, sy1] of strips) {
      const [i0, i1] = span(sx0, sx1, width)
      const [j0, j1] = span(sy0, sy1, height)
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) raster.ambiguous[j * width + i] = 1
    }
  }
  const fill = (x0: number, x1: number, y0: number, y1: number, paintSample: (index: number) => void) => {
    markRect(x0, x1, y0, y1)
    const [i0, i1] = span(x0, x1, width)
    const [j0, j1] = span(y0, y1, height)
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) paintSample(j * width + i)
  }
  const setColor = (index: number, color: Color) => {
    raster.red[index] = color[0]
    raster.green[index] = color[1]
    raster.blue[index] = color[2]
  }

  // Container, with the corner arcs tested at each sample in the four corner squares.
  const radius = paintGeometry.cornerRadius
  const containerRight = left + geometry.containerWidth
  const containerBottom = top + geometry.containerHeight
  fill(left, containerRight, top, containerBottom, index => {
    const x = offset + stride * (index % width)
    const y = offset + stride * Math.floor(index / width)
    const dx = Math.max(0, radius - (x - left)) + Math.max(0, (x - left) - (geometry.containerWidth - radius))
    const dy = Math.max(0, radius - (y - top)) + Math.max(0, (y - top) - (geometry.containerHeight - radius))
    const distance = dx * dx + dy * dy
    if (dx > 0 && dy > 0 && Math.abs(distance - radius * radius) <= 2 * radius * band) raster.ambiguous[index] = 1
    if (distance > radius * radius) return
    inContainer[index] = 1
    raster.layer[index] = paintLayer.container
    setColor(index, paintColors.container)
  })

  // Header bars, clipped to the container above the scroller.
  const headerBar = (lineTop: number, lineLeft: number, lineWidth: number, inkTop: number, inkBottom: number) => {
    fill(left + lineLeft, left + lineLeft + lineWidth, top + lineTop + inkTop, top + lineTop + inkBottom, index => {
      const y = offset + stride * Math.floor(index / width)
      if (inContainer[index] !== 1 || !(y < scrollerPageTop)) return
      raster.layer[index] = paintLayer.headerInk
      setColor(index, paintColors.headerInk)
    })
  }
  const geometryConstants = paintGeometry
  headerBar(geometry.line1Top, geometryConstants.headerLine1Left, paint.headerLine1Width, geometryConstants.headerLine1InkTop, geometryConstants.headerLine1InkBottom)
  headerBar(geometry.line2Top, geometryConstants.headerLine2Left, paint.headerLine2Width, geometryConstants.headerLine2InkTop, geometryConstants.headerLine2InkBottom)

  // Scroller.
  const scrollerPageBottom = scrollerPageTop + geometry.scrollerHeight
  fill(left, containerRight, scrollerPageTop, scrollerPageBottom, index => {
    if (inContainer[index] !== 1) return
    inScroller[index] = 1
    raster.layer[index] = paintLayer.scroller
    setColor(index, paintColors.display)
  })

  const viewTop = offset - band
  const viewBottom = offset + stride * height + band
  const commentColor = text === 'bars' ? paintColors.commentBar : paintColors.commentGlyph
  for (let row = 0; row < geometry.rows.length; row++) {
    const record = geometry.rows[row]!
    if (scrollerPageTop + record.bottom < viewTop || scrollerPageTop + record.top > viewBottom) continue
    const indentWidth = tables.indents[row]! * threadLayout.indentWidth
    // Text bars: line k covers [commentTop + 14k + 3, commentTop + 14k + 11), inside the comment box and text height.
    const boxTop = scrollerPageTop + record.commentTop
    const boxBottom = boxTop + Math.min(record.commentHeight, record.textHeight)
    const boxLeft = left + indentWidth + threadLayout.commentLeftGap
    const boxRight = containerRight - threadLayout.commentRightGap
    if (boxBottom > boxTop && boxRight > boxLeft) {
      markRect(boxLeft, boxRight, boxTop, boxBottom)
      if (text === 'bars') {
        const lines = Math.ceil(record.textHeight / paintGeometry.linePitch)
        for (let line = 0; line < lines; line++) {
          const barTop = boxTop + paintGeometry.linePitch * line + paintGeometry.barTop
          const barBottom = boxTop + paintGeometry.linePitch * line + paintGeometry.barBottom
          if (barBottom < viewTop || barTop > viewBottom) continue
          fill(boxLeft, boxRight, Math.max(barTop, boxTop), Math.min(barBottom, boxBottom), index => {
            if (inScroller[index] !== 1) return
            raster.layer[index] = paintLayer.commentInk
            setColor(index, commentColor)
          })
        }
      } else {
        // Glyphs: each character owns [its x, the next character's x) on its line, and paints the atlas cell there.
        if (glyphs === undefined) throw new Error('glyph text needs the text tables')
        const {tables: textTables, atlas} = glyphs
        const firstLine = textTables.lineBase[row]!
        for (let line = firstLine; line < firstLine + textTables.lineCount[row]!; line++) {
          const lineTopPage = boxTop + textTables.lineTop[line]!
          if (lineTopPage + atlas.cellHeight < viewTop || lineTopPage > viewBottom) continue
          const lineBottomPage = Math.min(lineTopPage + atlas.cellHeight, boxBottom)
          // Glyph rows start at fractional offsets when rows animate: samples near a row boundary are ambiguous.
          const [j0, j1] = span(Math.max(lineTopPage, boxTop) - band, lineBottomPage + band, height)
          const [i0, i1] = span(boxLeft, boxRight, width)
          for (let j = j0; j < j1; j++) {
            const offsetInLine = offset + stride * j - lineTopPage
            const fraction = offsetInLine - Math.floor(offsetInLine)
            if (fraction < band || fraction > 1 - band) for (let i = i0; i < i1; i++) raster.ambiguous[j * width + i] = 1
          }
          const start = textTables.lineStart[line]!
          const length = textTables.lineLength[line]!
          for (let index = 0; index < length; index++) {
            const character = start + index
            const x0 = boxLeft + textTables.charX[character]!
            const x1 = index + 1 < length ? boxLeft + textTables.charX[character + 1]! : Number.POSITIVE_INFINITY
            const code = textTables.charCode[character]!
            const [ci0, ci1] = span(Math.max(x0, boxLeft), Math.min(x1, x0 + atlas.cellWidth, boxRight), width)
            const [cj0, cj1] = span(Math.max(lineTopPage, boxTop), lineBottomPage, height)
            for (let j = cj0; j < cj1; j++) {
              const glyphRow = Math.floor(offset + stride * j - lineTopPage)
              for (let i = ci0; i < ci1; i++) {
                const sample = j * width + i
                if (inScroller[sample] !== 1) continue
                const glyphColumn = Math.floor(offset + stride * i - x0)
                if (atlas.bits[(code * atlas.cellHeight + glyphRow) * atlas.cellWidth + glyphColumn] !== 1) continue
                raster.layer[sample] = paintLayer.commentInk
                setColor(sample, commentColor)
              }
            }
          }
        }
      }
    }
    // Banner and label.
    const bannerTop = scrollerPageTop + record.userTop
    const bannerBottom = bannerTop + record.userHeight
    const bannerLeft = left + indentWidth
    const alpha = record.userOpacity
    const bannerColor: Color = [0, 1, 2].map(channel =>
      paintColors.display[channel]! + alpha * (paintColors.emphasisNone[channel]! - paintColors.display[channel]!)
      + record.emphasis * alpha * (paintColors.emphasis[channel]! - paintColors.emphasisNone[channel]!)) as unknown as Color
    fill(bannerLeft, containerRight, bannerTop, bannerBottom, index => {
      if (inScroller[index] !== 1) return
      raster.layer[index] = paintLayer.banner
      raster.emphasis[index] = record.emphasis
      setColor(index, bannerColor)
    })
    const labelWidth = record.collapsed === 1 ? paint.labelWidthCollapsed[row]! : paint.labelWidthExpanded[row]!
    const center = bannerTop + record.userHeight / 2
    const inkAlpha = Math.min(1, Math.max(0, record.userTextOpacity)) * alpha
    const inkColor: Color = [0, 1, 2].map(channel => bannerColor[channel]! + inkAlpha * (paintColors.bannerInk[channel]! - bannerColor[channel]!)) as unknown as Color
    fill(bannerLeft + paintGeometry.labelLeft, bannerLeft + paintGeometry.labelLeft + labelWidth, center - paintGeometry.labelHalfHeight, center + paintGeometry.labelHalfHeight, index => {
      const y = offset + stride * Math.floor(index / width)
      const x = offset + stride * (index % width)
      if (inScroller[index] !== 1 || !(y >= bannerTop && y < bannerBottom && x >= bannerLeft)) return
      raster.layer[index] = paintLayer.bannerInk
      raster.emphasis[index] = record.emphasis
      setColor(index, inkColor)
    })
  }

  // Gutters above everything.
  for (let row = 0; row < geometry.rows.length; row++) {
    const record = geometry.rows[row]!
    if (record.gutterVisible !== 1) continue
    const indent = tables.indents[row]!
    const x0 = left + indent * threadLayout.indentWidth
    const clipBottom = containerBottom - (indent === 0 ? paintGeometry.levelZeroGutterInset : 0)
    const y0 = scrollerPageTop + record.gutterTop
    const y1 = Math.min(scrollerPageTop + record.gutterBottom, clipBottom)
    const color = record.gutterEmphasis === 1 ? paintColors.emphasis : paintColors.emphasisNone
    fill(x0, x0 + paintGeometry.gutterWidth, y0, y1, index => {
      raster.layer[index] = paintLayer.gutter
      raster.emphasis[index] = record.gutterEmphasis
      setColor(index, color)
    })
  }

  // Row under each scanline: count of tops at or above it, from a sorted copy of the tops.
  const sortedTops = geometry.rows.map(record => record.top).sort((a, b) => a - b)
  for (let j = 0; j < height; j++) {
    const localY = offset + stride * j - scrollerPageTop
    let low = 0
    let high = sortedTops.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (sortedTops[middle]! <= localY) low = middle + 1
      else high = middle
    }
    const rowUnder = low - 1
    const nearTop = (low > 0 && localY - sortedTops[low - 1]! < band) || (low < sortedTops.length && sortedTops[low]! - localY < band)
    for (let i = 0; i < width; i++) {
      const index = j * width + i
      if (inScroller[index] !== 1) continue
      raster.row[index] = rowUnder
      if (nearTop) raster.ambiguous[index] = 1
    }
  }
  return raster
}

export type RasterComparison = {
  samples: number
  ambiguousSamples: number
  // Outside ambiguous samples: layer, row or emphasis differ.
  decisionMismatches: number
  // Inside ambiguous samples.
  ambiguousMismatches: number
  largestColorDifference: number
  firstMismatch: string | null
  // Samples the circuit put on comment ink, and how many of them are outside the band, where the decision was compared.
  // With glyph text and a wide band most ink is ambiguous, e.g. every sample of a line whose top isn't on a whole pixel.
  inkSamples: number
  inkSamplesCompared: number
}

// outputs: count × 6 values in pixelOutputField order.
export function compareRaster(raster: Raster, outputs: ArrayLike<number>, outputSize: number): RasterComparison {
  const count = raster.grid.width * raster.grid.height
  const result: RasterComparison = {samples: count, ambiguousSamples: 0, decisionMismatches: 0, ambiguousMismatches: 0, largestColorDifference: 0, firstMismatch: null, inkSamples: 0, inkSamplesCompared: 0}
  for (let index = 0; index < count; index++) {
    const base = index * outputSize
    const layer = outputs[base + 3]!
    const row = outputs[base + 4]!
    const emphasis = outputs[base + 5]!
    const same = layer === raster.layer[index] && row === raster.row[index] && emphasis === raster.emphasis[index]
    const onInk = layer === paintLayer.commentInk
    if (onInk) result.inkSamples++
    if (raster.ambiguous[index] === 1) {
      result.ambiguousSamples++
      if (!same) result.ambiguousMismatches++
      continue
    }
    if (onInk) result.inkSamplesCompared++
    if (!same) {
      result.decisionMismatches++
      result.firstMismatch ??= `sample ${index % raster.grid.width},${Math.floor(index / raster.grid.width)}: circuit layer ${layer} row ${row} emphasis ${emphasis}, reference layer ${raster.layer[index]} row ${raster.row[index]} emphasis ${raster.emphasis[index]}`
      continue
    }
    const difference = Math.max(Math.abs(outputs[base]! - raster.red[index]!), Math.abs(outputs[base + 1]! - raster.green[index]!), Math.abs(outputs[base + 2]! - raster.blue[index]!))
    result.largestColorDifference = Math.max(result.largestColorDifference, difference)
  }
  return result
}

// Emphasized samples in outputs: on a banner or its label (a pressed comment), and on a gutter (a hovered or pressed gutter).
export function countEmphasisSamples(outputs: ArrayLike<number>, outputSize: number) {
  let banner = 0
  let gutter = 0
  for (let base = 0; base < outputs.length; base += outputSize) {
    if (outputs[base + 5] !== 1) continue
    const layer = outputs[base + 3]
    if (layer === paintLayer.gutter) gutter++
    else if (layer === paintLayer.banner || layer === paintLayer.bannerInk) banner++
  }
  return {banner, gutter}
}
