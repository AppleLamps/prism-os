// What the per-pixel program draws, shared by the circuit builder and the float64
// rasterizer: colors, paint layers, text bar geometry, and static text widths.
//
// The picture follows the DOM that hn-thread's demo builds (demo.ts, demo.css):
// a white rounded container, the submission header, the comments scroller, per
// row a sticky user banner (z-index 1) over the comment text, and the gutter
// lines that the demo strokes on a canvas above everything. Text is either one
// gray bar per 14px line ('bars') or glyphs read from a 1-bit atlas ('glyphs').
import {threadLayout, type ThreadTables} from '../hn-thread/thread-model.ts'
import type {HNThread} from '../hn-thread/hn-data.ts'

export type Color = readonly [number, number, number]

// CSS hsl() to 0..255, rounded to integers so every color is an exact FP32 constant.
export function hslColor(hueDegrees: number, saturation: number, lightness: number): Color {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = hueDegrees / 60
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1))
  const [red, green, blue] = huePrime < 1 ? [chroma, secondary, 0]
    : huePrime < 2 ? [secondary, chroma, 0]
      : huePrime < 3 ? [0, chroma, secondary]
        : huePrime < 4 ? [0, secondary, chroma]
          : huePrime < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary]
  const match = lightness - chroma / 2
  return [Math.round((red + match) * 255), Math.round((green + match) * 255), Math.round((blue + match) * 255)]
}

export type TextMode = 'bars' | 'glyphs'

export const paintColors = {
  page: [240, 240, 229] as Color,
  container: [255, 255, 255] as Color,
  headerInk: [92, 92, 92] as Color,
  display: hslColor(60, 0.28, 0.95),
  commentBar: [196, 196, 186] as Color,
  commentGlyph: [28, 28, 28] as Color,
  bannerInk: [92, 92, 92] as Color,
  emphasisNone: hslColor(37, 0.33, 0.87),
  emphasis: hslColor(37, 0.25, 0.75),
} as const

// Paint layers, topmost last. The per-pixel `layer` output is the topmost layer covering the pixel center.
export const paintLayer = {page: 0, container: 1, headerInk: 2, scroller: 3, commentInk: 4, banner: 5, bannerInk: 6, gutter: 7} as const

export const pixelOutputField = {red: 0, green: 1, blue: 2, layer: 3, row: 4, emphasis: 5, size: 6} as const

export const paintGeometry = {
  cornerRadius: threadLayout.containerBorderRadius,
  // Header lines: left edge in container coordinates, and the ink band relative to the line's top.
  headerLine1Left: 8,
  headerLine1InkTop: 4,
  headerLine1InkBottom: 14,
  headerLine2Left: 24,
  headerLine2InkTop: 3,
  headerLine2InkBottom: 11,
  // Banner label: 8px from the banner's left edge, an 8px band centered on the banner.
  labelLeft: 8,
  labelHalfHeight: 4,
  // Comment text: 14px lines; a bar covers rows 3..11 of each line.
  linePitch: 14,
  barTop: 3,
  barBottom: 11,
  // Gutter lines are 1px wide at x = indent * 24 in container coordinates.
  gutterWidth: 1,
  // The demo stops level-0 gutters 8px above the container's bottom edge.
  levelZeroGutterInset: 8,
} as const

export type PaintTables = {
  // Banner label widths per row, expanded ("[–]") and collapsed ("[+N]").
  labelWidthExpanded: number[]
  labelWidthCollapsed: number[]
  headerLine1Width: number
  headerLine2Width: number
}

export type MeasureText = (text: string, font: string) => number

export function bannerLabel(thread: HNThread, tables: ThreadTables, row: number, collapsed: boolean) {
  const comment = thread.comments[row]!
  const toggle = collapsed ? `[+${tables.descendantCounts[row]! + 1}]` : '[–]'
  return `▲ ${comment.user} ${comment.age} ${toggle}`
}

export function headerLines(thread: HNThread) {
  return {
    line1: `▲ ${thread.title} (${thread.link})`,
    line2: `${thread.points} points by ${thread.submitter} on ${thread.submissionDate} | ${thread.comments.length} comments`,
  }
}

// Widths are quantized to 1/64px so every edge is an exact FP32 constant.
export function paintTables(thread: HNThread, tables: ThreadTables, measure: MeasureText): PaintTables {
  const quantize = (width: number) => Math.round(width * 64) / 64
  const rows = Array.from({length: tables.rowCount}, (_, row) => row)
  const header = headerLines(thread)
  return {
    labelWidthExpanded: rows.map(row => quantize(measure(bannerLabel(thread, tables, row, false), '11px Verdana, Geneva, sans-serif'))),
    labelWidthCollapsed: rows.map(row => quantize(measure(bannerLabel(thread, tables, row, true), '11px Verdana, Geneva, sans-serif'))),
    headerLine1Width: quantize(measure(header.line1, '13px Verdana, Geneva, sans-serif')),
    headerLine2Width: quantize(measure(header.line2, '11px Verdana, Geneva, sans-serif')),
  }
}
