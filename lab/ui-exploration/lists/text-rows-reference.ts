// The text rows list in plain JavaScript, written from the task's definition rather than from the program, in float64
// with loops that stop early:
// - A row's height is pretext's layout of its text at Math.max(containerWidth, minimumWidth), plus 16 px of padding.
//   minimumWidth is the narrowest whole-pixel container width at which the row has at most breakpointCapacity more lines
//   than at the widest container width and is at most 256 px tall, found by scanning every width down from the widest.
// - Rows stack from the top. The view clamps to the content. A view that showed the end of the rows keeps showing the
//   end, e.g. when a row is appended. Otherwise the row at the top of the view as the DOM shows it keeps its position on
//   screen when the rows above it change height, like CSS scroll anchoring. The DOM shows the last frame's layout at the
//   scroll position it reports now, so that row is the first row of the last frame's layout whose bottom is below
//   today's scrollTop, e.g. after a scroll and a resize land in one frame, the row the user scrolled to.
// - A row is in view when `top + height > scrollTop && top < scrollTop + viewportHeight`, like lists'
//   referenceVisibleRows. Row r goes into DOM slot r % slotCount when r is among the slotCount rows from the top row of
//   the view, and any row in view past those rows sets slotOverflow.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {prepareText, textRowHeight, textRowLayout, type PreparedText} from './text-rows-prepare.ts'
import type {TextRowsInput, TextRowsOptions} from './text-rows.ts'

export function referenceMinimumWidth(prepared: PreparedText, breakpointCapacity: number) {
  const {minimumContainerWidth, maximumContainerWidth, lineHeight, maximumRowHeight} = textRowLayout
  const widestHeight = textRowHeight(prepared, maximumContainerWidth)
  invariant(widestHeight <= maximumRowHeight, `a text row must be at most ${maximumRowHeight} px tall at ${maximumContainerWidth} px, got ${widestHeight} px`)
  let width: number = maximumContainerWidth
  while (width > minimumContainerWidth) {
    const height = textRowHeight(prepared, width - 1)
    if ((height - widestHeight) / lineHeight > breakpointCapacity || height > maximumRowHeight) break
    width--
  }
  return width
}

export type ReferenceSlot = {slot: number, row: number, top: number, height: number, layoutWidth: number, clamped: number}
export type ReferenceOutput = {scrollTop: number, firstRow: number, totalHeight: number, full: number, slotOverflow: number, slots: ReferenceSlot[]}

export function createTextRowsReference(options: TextRowsOptions) {
  const rows: {prepared: PreparedText, minimumWidth: number}[] = []
  // The last frame's layout, which the DOM shows before the next frame.
  let previous = {tops: [] as number[], heights: [] as number[], totalHeight: 0}
  return {
    setRow(row: number, text: string) {
      invariant(row <= rows.length && row < options.capacity, `row ${row} must be an existing row or the next one`)
      const prepared = prepareText(text)
      rows[row] = {prepared, minimumWidth: referenceMinimumWidth(prepared, options.breakpointCapacity)}
    },
    frame({containerWidth, viewportHeight, scrollTop: domScrollTop, rowCount}: TextRowsInput): ReferenceOutput {
      invariant(rowCount <= rows.length, `the row count ${rowCount} is past the ${rows.length} rows that have text`)
      const tops: number[] = []
      const heights: number[] = []
      let top = 0
      for (let row = 0; row < rowCount; row++) {
        const {prepared, minimumWidth} = rows[row]!
        const height = textRowHeight(prepared, Math.max(containerWidth, minimumWidth))
        tops.push(top)
        heights.push(height)
        top += height
      }
      const totalHeight = top
      const maximumScroll = Math.max(0, totalHeight - viewportHeight)
      let scrollTop: number
      if (domScrollTop + viewportHeight >= previous.totalHeight) {
        scrollTop = maximumScroll
      } else {
        // The DOM's scroll position is above the last frame's total height, so some row of the last frame ends below it.
        let anchorRow = 0
        while (previous.tops[anchorRow]! + previous.heights[anchorRow]! <= domScrollTop) anchorRow++
        const screenTop = previous.tops[anchorRow]! - domScrollTop
        const anchorTopNow = anchorRow < rowCount ? tops[anchorRow]! : totalHeight
        scrollTop = Math.min(Math.max(anchorTopNow - screenTop, 0), maximumScroll)
      }
      let firstRow = 0
      while (firstRow < rowCount && tops[firstRow]! + heights[firstRow]! <= scrollTop) firstRow++
      const slots: ReferenceSlot[] = []
      let slotOverflow = 0
      for (let row = 0; row < rowCount; row++) {
        if (!(tops[row]! + heights[row]! > scrollTop && tops[row]! < scrollTop + viewportHeight)) continue
        if (row >= firstRow + options.slotCount) {
          slotOverflow = 1
          break
        }
        const minimumWidth = rows[row]!.minimumWidth
        slots.push({slot: row % options.slotCount, row, top: tops[row]!, height: heights[row]!, layoutWidth: Math.max(containerWidth, minimumWidth), clamped: containerWidth < minimumWidth ? 1 : 0})
      }
      slots.sort((left, right) => left.slot - right.slot)
      previous = {tops, heights, totalHeight}
      return {scrollTop, firstRow, totalHeight, full: rowCount >= options.capacity ? 1 : 0, slotOverflow, slots}
    },
  }
}
