// The reference for the Notes flow: dynamic-layout's layoutColumn carving for
// several rectangles, with pretext's layoutNextLineRange per band. Plain float64;
// it never imports circuit code.
import type {FastParagraph} from './fast-walker.ts'

export type NotesArrangement = {
  columnLeft: number
  columnWidth: number
  obstacles: {left: number, top: number, width: number, height: number, active: boolean}[]
}
export type NotesFlowOptions = {padding: number, lineHeight: number, bands: number, horizontalPadding: number, verticalPadding: number, minimumSlotWidth: number}
type Cursor = {segmentIndex: number, graphemeIndex: number}
type LineRange = {width: number, start: Cursor, end: Cursor}
type Interval = {left: number, right: number}

export type ReferenceNotesFlow = {
  bands: {usable: boolean, left: number, slotWidth: number, line: LineRange | null}[]
  segments: {visible: boolean, x: number, y: number}[]
}

export function referenceNotesFlow(
  layoutNextLineRange: (prepared: never, start: Cursor, maxWidth: number) => LineRange | null,
  prepared: object,
  paragraph: FastParagraph,
  arrangement: NotesArrangement,
  options: NotesFlowOptions,
): ReferenceNotesFlow {
  const bands: ReferenceNotesFlow['bands'] = []
  const segments = paragraph.widths.map(() => ({visible: false, x: 0, y: 0}))
  let cursor: Cursor = {segmentIndex: 0, graphemeIndex: 0}
  for (let band = 0; band < options.bands; band++) {
    const bandTop = options.padding + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    const blocked: Interval[] = arrangement.obstacles
      .filter(obstacle => obstacle.active && !(bandBottom <= obstacle.top - options.verticalPadding || bandTop >= obstacle.top + obstacle.height + options.verticalPadding))
      .map(obstacle => ({left: obstacle.left - options.horizontalPadding, right: obstacle.left + obstacle.width + options.horizontalPadding}))
    let slots: Interval[] = [{left: arrangement.columnLeft, right: arrangement.columnLeft + arrangement.columnWidth}]
    for (const interval of blocked) {
      const next: Interval[] = []
      for (const slot of slots) {
        if (interval.right <= slot.left || interval.left >= slot.right) {
          next.push(slot)
          continue
        }
        if (interval.left > slot.left) next.push({left: slot.left, right: interval.left})
        if (interval.right < slot.right) next.push({left: interval.right, right: slot.right})
      }
      slots = next
    }
    slots = slots.filter(slot => slot.right - slot.left >= options.minimumSlotWidth)
    if (slots.length === 0) {
      bands.push({usable: false, left: 0, slotWidth: 0, line: null})
      continue
    }
    let slot = slots[0]!
    for (const candidate of slots.slice(1)) {
      const bestWidth = slot.right - slot.left
      const candidateWidth = candidate.right - candidate.left
      if (candidateWidth > bestWidth || (candidateWidth === bestWidth && candidate.left > slot.left)) slot = candidate
    }
    const slotWidth = slot.right - slot.left
    const line = layoutNextLineRange(prepared as never, cursor, slotWidth)
    bands.push({usable: true, left: slot.left, slotWidth, line})
    if (line === null) continue
    let x = slot.left
    for (let segment = line.start.segmentIndex; segment < line.end.segmentIndex; segment++) {
      segments[segment] = {visible: true, x, y: bandTop}
      x += paragraph.widths[segment]!
    }
    cursor = line.end
  }
  return {bands, segments}
}
