// The frame function in plain JS, derived from nicer-hacker-news's hn.js
// (render, lines 233-660) with the heights of the chenguini port
// (chenguini's demos/nicer-hacker-news/index.ts). It is the independent
// reference the circuit is checked against, so it keeps hn.js's control flow: the
// row search loop with `break`, the ancestor `while` loop, the gutter bottom loop
// over following rows, float64 arithmetic, and text heights from pretext itself
// instead of the prepared breakpoints.
//
// Extensions to hn.js, applied the same way in the circuit:
// - Collapse. Clicking a comment's sticky user banner (outside the gutter) toggles
//   `collapsed`. A collapsed comment keeps a 28px banner, and its descendants get
//   height 0. The toggle lands in the next frame's state.
// - A second eased height per row, `restHeight`, which follows collapse changes but
//   not the gutter peek. hn.js anchors the rows below the pointer by adding
//   `natural - height` of every row to the top gap; with collapse in the mix, the
//   gap is `restHeight - height`, so collapsing a comment doesn't move the rows above it.
// - Resize. When the container width changes, both heights shift by the change of
//   the row's natural height, so settled rows snap and running animations keep their
//   remaining distance. The chenguini port snaps only settled rows.
// - The keep-rendering check uses the sum of all rows' remaining distances instead
//   of checking each row, so it can render a few more frames than hn.js at the end
//   of an animation.
// - DOM slots: rows that are in view and at least 0.25px tall get slot numbers in row
//   order, up to slotCount.

import {commentWidthAt} from '../hn-thread/text-heights.ts'
import {threadLayout, type ThreadTables} from '../hn-thread/thread-model.ts'

export type FrameInputs = {
  windowWidth: number
  windowHeight: number
  scrollTopReal: number
  pointerX: number
  pointerY: number
  pointerDown: number
  click: number
}

export type ThreadState = {
  scrollTopPrevious: number
  scrollDeltaPrevious: number
  scrollerPeekUp: number
  containerWidthPrevious: number
  collapsed: number[]
  restHeights: number[]
  heights: number[]
  restTargetsPrevious: number[]
}

export const pointerOnCode = {none: 0, row: 1, gutter: 2, threadPrevious: 3, threadNext: 4} as const
// 0 auto, 1 comment (JS picks text or link), 2 row-resize, 3 n-resize, 4 s-resize, 5 collapse toggle
export const cursorNames = ['auto', 'text', 'row-resize', 'n-resize', 's-resize', 'pointer'] as const

export type RowFrame = {
  textHeight: number
  naturalHeight: number
  shrink: number
  top: number
  height: number
  restHeight: number
  collapsed: number
  userTop: number
  userHeight: number
  userOpacity: number
  userTextOpacity: number
  commentTop: number
  commentHeight: number
  commentFadeSize: number
  visible: number
  occupiesSlot: number
  emphasis: number
  gutterTop: number
  gutterBottom: number
  gutterVisible: number
  gutterEmphasis: number
}

export const rowFrameFields = [
  'textHeight', 'naturalHeight', 'shrink', 'top', 'height', 'restHeight', 'collapsed', 'userTop', 'userHeight',
  'userOpacity', 'userTextOpacity', 'commentTop', 'commentHeight', 'commentFadeSize', 'visible', 'occupiesSlot',
  'emphasis', 'gutterTop', 'gutterBottom', 'gutterVisible', 'gutterEmphasis',
] as const satisfies readonly (keyof RowFrame)[]

export type SlotFrame = {
  present: number
  row: number
  userTop: number
  userHeight: number
  userOpacity: number
  userTextOpacity: number
  commentTop: number
  commentHeight: number
  commentFadeSize: number
  emphasis: number
  collapsed: number
}

export const slotFrameFields = [
  'present', 'row', 'userTop', 'userHeight', 'userOpacity', 'userTextOpacity', 'commentTop', 'commentHeight',
  'commentFadeSize', 'emphasis', 'collapsed',
] as const satisfies readonly (keyof SlotFrame)[]

export type GlobalFrame = {
  scrollTop: number
  scrollTopCap: number
  containerWidth: number
  containerLeft: number
  containerHeight: number
  submissionHeight: number
  submissionLine1Top: number
  submissionLine2Top: number
  searchLeft: number
  searchTop: number
  scrollerTop: number
  scrollerHeight: number
  scrollerPeekUp: number
  placeholderHeight: number
  pointerOn: number
  pointedRow: number
  ancestor: number
  toggleRegion: number
  peeking: number
  cursorCode: number
  scheduleNextRender: number
  slotOverflow: number
}

export const globalFrameFields = [
  'scrollTop', 'scrollTopCap', 'containerWidth', 'containerLeft', 'containerHeight', 'submissionHeight',
  'submissionLine1Top', 'submissionLine2Top', 'searchLeft', 'searchTop', 'scrollerTop', 'scrollerHeight',
  'scrollerPeekUp', 'placeholderHeight', 'pointerOn', 'pointedRow', 'ancestor', 'toggleRegion', 'peeking',
  'cursorCode', 'scheduleNextRender', 'slotOverflow',
] as const satisfies readonly (keyof GlobalFrame)[]

export type ThreadFrame = {
  global: GlobalFrame
  rows: RowFrame[]
  slots: SlotFrame[]
  next: ThreadState
}

// How far each continuous decision was from its threshold, in px, so a test can tell
// an FP32 rounding tie from a real disagreement.
export type FrameMargins = {
  smoothing: number
  fits: number
  overscroll: number
  hit: number
  toggle: number
  peekMoving: number
  widthChanged: number
  moving: number
  cursor: number
  // Per row: the visibility comparisons, visibility plus the 0.25px slot threshold, and the two <= 4px
  // comparisons that pick the gutter top. `gutterBottom >= 0` needs no margin: gutterBottom >= gutterTop >= 0.
  visible: number[]
  occupancy: number[]
  gutterSelect: number[]
  gutterVisible: number[]
}

// 'rank': rows in view that are at least 0.25px tall get slots in row order (bounded visibility compaction).
// 'window': slot s shows the row at (first visible row + s), if that row is visible. Cheaper, but zero-height rows
// in view (a collapsed subtree, a peek) use up slots.
// 'none' (added in pixel-output): no slot section at all; a per-pixel program reads the per-row outputs instead.
export type SlotMode = 'rank' | 'window' | 'none'

export type FrameBranches = {fits: boolean, smoothing: boolean, widthChanged: boolean}

export type ReferenceModel = {
  tables: ThreadTables
  textHeightAt(row: number, commentWidth: number): number
}

// hn.js clamp: like Math.max(min, Math.min(max, v)), and min wins when max < min.
function clamp(minimum: number, value: number, maximum: number) {
  return value > maximum ? (maximum < minimum ? minimum : maximum) : value < minimum ? minimum : value
}

export function containerWidthF(windowWidth: number) {
  return clamp(threadLayout.minimumContainerWidth, windowWidth, threadLayout.maximumContainerWidth)
}

export function referenceFrame(
  model: ReferenceModel,
  state: ThreadState,
  inputs: FrameInputs,
  slotCount: number,
  slotMode: SlotMode = 'rank',
): {frame: ThreadFrame, margins: FrameMargins, branches: FrameBranches} {
  const layout = threadLayout
  const {tables} = model
  const rowCount = tables.rowCount
  const pointerDown = inputs.pointerDown === 1
  let scheduleNextRender = false
  // Distance from a threshold for decisions both implementations compute exactly (integer heights, window widths on a
  // 1/64px grid): landing exactly on the threshold isn't a tie there. Other decisions keep the plain distance, because
  // float64 can hit a threshold exactly while FP32 lands an ulp to one side.
  const exactTieDistance = (difference: number) => difference === 0 ? Infinity : Math.abs(difference)

  // hn.js 243-260: smooth scrollTop over frames
  let scrollTop: number
  const scrollTopReal = inputs.scrollTopReal
  if (Math.abs(state.scrollDeltaPrevious) > 0.01) {
    scrollTop = state.scrollTopPrevious * 0.55 + scrollTopReal * 0.45
    scheduleNextRender = true
  } else {
    scrollTop = scrollTopReal
  }
  // A zero delta is exactly zero in both, far from the 0.01 threshold's rounding.
  const smoothingMargin = state.scrollDeltaPrevious === 0 ? Infinity : Math.abs(Math.abs(state.scrollDeltaPrevious) - 0.01)
  const nextScrollDeltaPrevious = scrollTop - state.scrollTopPrevious
  const scrollTopCap = Math.max(0, scrollTop)

  // chenguini index.ts 309-326: comment heights at this width; extension: collapse
  const containerWidth = containerWidthF(inputs.windowWidth)
  const containerLeft = (inputs.windowWidth - containerWidth) / 2
  const widthChanged = containerWidth !== state.containerWidthPrevious
  const widthChangedMargin = exactTieDistance(containerWidth - state.containerWidthPrevious)
  const textHeights: number[] = []
  const naturalHeights: number[] = []
  for (let row = 0; row < rowCount; row++) {
    const textHeight = model.textHeightAt(row, commentWidthAt(containerWidth, tables.indents[row]!))
    textHeights.push(textHeight)
    let hidden = false
    for (const ancestor of tables.ancestors[row]!) if (state.collapsed[ancestor] === 1) hidden = true
    naturalHeights.push(hidden ? 0 : state.collapsed[row] === 1 ? layout.collapsedRowHeight : textHeight + layout.rowHeightExtra)
  }

  // hn.js 266-309: submission, comments, vertical sizing
  const currentContainerHeight = inputs.windowHeight - layout.currentContainerTop - layout.containerBottomGap
  let submissionLine1Top: number
  let submissionHeight: number
  let scrollerHeightNatural: number
  let submissionLinesGap: number
  let fitsMargin = Infinity
  let overscrollMargin = Infinity
  let fitsBranch = false
  {
    const line1TopMax = 24
    const line1TopMin = 12
    const linesGapMax = 8
    const linesGapMin = 4
    let rowsHeightNatural = 0
    for (let i = 0; i < rowCount; i++) rowsHeightNatural += naturalHeights[i]!
    fitsMargin = exactTieDistance(currentContainerHeight - layout.submissionHeightNatural - rowsHeightNatural)
    if (layout.submissionHeightNatural + rowsHeightNatural < currentContainerHeight) {
      fitsBranch = true
      const delta = Math.min(layout.submissionHeightDelta, currentContainerHeight - layout.submissionHeightNatural - rowsHeightNatural)
      submissionHeight = layout.submissionHeightNatural + delta
      submissionLine1Top = line1TopMax + delta * ((line1TopMax - line1TopMin) / layout.submissionHeightDelta)
      submissionLinesGap = linesGapMax + delta * ((linesGapMax - linesGapMin) / layout.submissionHeightDelta)
      scrollerHeightNatural = rowsHeightNatural
    } else {
      if (scrollTop < 0) {
        submissionLine1Top = line1TopMax - scrollTop * 0.7
        submissionLinesGap = linesGapMax - scrollTop * 0.3
      } else if (scrollTop < layout.submissionHeightDelta) {
        submissionLine1Top = line1TopMax - scrollTop * ((line1TopMax - line1TopMin) / layout.submissionHeightDelta)
        submissionLinesGap = linesGapMax - scrollTop * ((linesGapMax - linesGapMin) / layout.submissionHeightDelta)
      } else {
        submissionLine1Top = line1TopMin
        submissionLinesGap = linesGapMin
      }
      submissionHeight = layout.submissionHeightNatural - Math.min(layout.submissionHeightDelta, scrollTop)
      scrollerHeightNatural = currentContainerHeight - submissionHeight
      const scrollTopMax = rowsHeightNatural - scrollerHeightNatural
      // The squash below is continuous in scrollTop (it starts at 0), so it has no tie to report.
      overscrollMargin = Infinity
      if (scrollTop > scrollTopMax) {
        scrollerHeightNatural = scrollerHeightNatural - (scrollTop - scrollTopMax) / 2
      }
    }
  }

  // hn.js 314-343: hit testing on natural heights, ignoring animations
  const pageXLocal = inputs.pointerX - containerLeft
  const pageY = inputs.pointerY
  let pointerOn: number = pointerOnCode.none
  let pointedRow = -1
  let pointedAncestor = -1
  let toggleRegion = 0
  let toggleMargin = Infinity
  let hitMargin = Math.min(
    Math.abs(pageXLocal),
    Math.abs(pageXLocal - containerWidth),
    Math.abs(pageY - layout.currentContainerTop),
    Math.abs(pageY - (layout.currentContainerTop + currentContainerHeight)),
    Math.abs(pageY - (layout.currentContainerTop + submissionHeight)),
  )
  if (0 <= pageXLocal && pageXLocal < containerWidth) {
    if (pageY <= layout.currentContainerTop) {
      pointerOn = pointerOnCode.threadPrevious
    } else if (pageY >= layout.currentContainerTop + currentContainerHeight) {
      pointerOn = pointerOnCode.threadNext
    } else if (layout.currentContainerTop + submissionHeight < pageY && pageY < layout.currentContainerTop + currentContainerHeight) {
      let rowTop = submissionHeight - scrollTopCap + layout.currentContainerTop
      const indentPointed = Math.floor(pageXLocal / layout.indentWidth)
      {
        let boundary = rowTop
        hitMargin = Math.min(hitMargin, Math.abs(pageY - boundary))
        for (let i = 0; i < rowCount; i++) {
          boundary += naturalHeights[i]!
          hitMargin = Math.min(hitMargin, Math.abs(pageY - boundary))
        }
        for (let level = 1; level <= tables.maxIndent + 1; level++) hitMargin = Math.min(hitMargin, Math.abs(pageXLocal - level * layout.indentWidth))
      }
      for (let i = 0; i < rowCount; i++) {
        const height = naturalHeights[i]!
        if (rowTop <= pageY && pageY < rowTop + height) {
          if (indentPointed <= tables.indents[i]!) {
            let ancestor = i
            while (ancestor > 0 && tables.indents[ancestor]! > indentPointed) ancestor--
            pointerOn = pointerOnCode.gutter
            pointedRow = i
            pointedAncestor = ancestor
          } else {
            pointerOn = pointerOnCode.row
            pointedRow = i
            // Extension: the banner, clamped like the visual sticky banner but on natural geometry, toggles collapse.
            const scrollerTopPage = layout.currentContainerTop + submissionHeight
            const bannerTop = Math.max(rowTop, Math.min(scrollerTopPage, rowTop + height - layout.userHeightNatural))
            toggleRegion = pageY < bannerTop + layout.userHeightNatural ? 1 : 0
            toggleMargin = Math.abs(bannerTop + layout.userHeightNatural - pageY)
          }
          break
        }
        rowTop += height
      }
    }
  }
  const onGutter = pointerOn === pointerOnCode.gutter
  const peeking = pointerDown && onGutter

  const nextCollapsed = [...state.collapsed]
  if (inputs.click === 1 && toggleRegion === 1) nextCollapsed[pointedRow] = 1 - nextCollapsed[pointedRow]!

  // hn.js 345-355: rows strictly between the ancestor and the pointed row shrink while pressing a gutter
  const shrink: number[] = []
  for (let i = 0; i < rowCount; i++) shrink.push(peeking && i > pointedAncestor && i < pointedRow ? 1 : 0)

  // hn.js 357-376: ancestor height and peek-up amount
  let ancestorHeightFinal = 0
  let scrollerPeekUpFinal = 0
  if (peeking) {
    const ancestor = pointedAncestor
    let scrollerCommentTopGapFinal = 0
    for (let i = ancestor + 1; i < rowCount; i++) if (shrink[i] === 1) scrollerCommentTopGapFinal += naturalHeights[i]!
    let ancestorTopFinal = scrollerCommentTopGapFinal
    for (let i = 0; i < ancestor; i++) ancestorTopFinal += naturalHeights[i]!
    ancestorHeightFinal = naturalHeights[ancestor]! - Math.max(0, (scrollTop - submissionHeight) - ancestorTopFinal)
    scrollerPeekUpFinal = clamp(0, scrollTop - ancestorTopFinal, submissionHeight)
  }
  const scrollerPeekUpDelta = (scrollerPeekUpFinal - state.scrollerPeekUp) / 5
  const nextScrollerPeekUp = state.scrollerPeekUp + scrollerPeekUpDelta
  if (Math.abs(scrollerPeekUpDelta) > 0.001) scheduleNextRender = true
  const peekMovingMargin = scrollerPeekUpFinal === state.scrollerPeekUp ? Infinity : Math.abs(Math.abs(scrollerPeekUpFinal - state.scrollerPeekUp) - 0.005)
  const scrollerHeight = scrollerHeightNatural + nextScrollerPeekUp

  // hn.js 377-392: ease row heights toward their final heights; extensions: rest height, resize shift
  const nextHeights: number[] = []
  const nextRestHeights: number[] = []
  let rowsScrollerTopGap = 0
  let movingSum = 0
  for (let i = 0; i < rowCount; i++) {
    const shift = widthChanged ? naturalHeights[i]! - state.restTargetsPrevious[i]! : 0
    const height = state.heights[i]! + shift
    const restHeight = state.restHeights[i]! + shift
    const rowHeightFinal = peeking && i === pointedAncestor ? ancestorHeightFinal
      : shrink[i] === 1 ? 0
        : naturalHeights[i]!
    const rowHeightFinalDelta = rowHeightFinal - height
    const nextHeight = height + rowHeightFinalDelta / 5
    const restDelta = naturalHeights[i]! - restHeight
    const nextRestHeight = restHeight + restDelta / 5
    nextHeights.push(nextHeight)
    nextRestHeights.push(nextRestHeight)
    rowsScrollerTopGap += nextRestHeight - nextHeight
    movingSum += Math.abs(rowHeightFinalDelta) + Math.abs(restDelta)
  }
  if (movingSum > 0.001) scheduleNextRender = true
  const movingMargin = movingSum === 0 ? Infinity : Math.abs(movingSum - 0.001)

  const scrollerTop = submissionHeight - nextScrollerPeekUp

  // hn.js 434-498: rows, sticky user banners, gutters
  const rows: RowFrame[] = []
  const visibleMargins: number[] = []
  const occupancyMargins: number[] = []
  const gutterSelectMargins: number[] = []
  const gutterVisibleMargins: number[] = []
  let rowTop = rowsScrollerTopGap + nextScrollerPeekUp - scrollTopCap
  for (let i = 0; i < rowCount; i++) {
    const height = nextHeights[i]!
    const rowBottom = rowTop + height
    const userHeight = Math.min(layout.userHeightNatural, height)
    const userTop = clamp(rowTop, 0, rowBottom - userHeight)
    const visible = rowTop <= scrollerHeight && rowBottom >= 0
    const commentHeight = Math.max(0, height - userHeight - layout.commentUserGapNatural)
    const commentFadeSize = layout.commentBottomGapNatural + Math.min(textHeights[i]! - commentHeight, layout.commentBottomGapNatural * 2)
    let gutterTop = rowBottom - (userTop + userHeight) <= 4 ? rowBottom
      : 0 <= userTop - rowTop && userTop - rowTop <= 4 ? rowTop + userHeight + 4
        : userTop + userHeight
    gutterTop = Math.max(gutterTop, 0)
    let gutterBottom = rowBottom
    for (let j = i + 1; j < rowCount && tables.indents[j]! > tables.indents[i]!; j++) gutterBottom += nextHeights[j]!
    gutterBottom = Math.max(gutterTop, gutterBottom - 4)
    const gutterVisible = gutterTop <= scrollerHeight && gutterBottom >= 0
    rows.push({
      textHeight: textHeights[i]!,
      naturalHeight: naturalHeights[i]!,
      shrink: shrink[i]!,
      top: rowTop,
      height,
      restHeight: nextRestHeights[i]!,
      collapsed: nextCollapsed[i]!,
      userTop,
      userHeight,
      userOpacity: userHeight / layout.userHeightNatural,
      userTextOpacity: (height - layout.userHeightNatural) / (layout.rowHeightExtra - layout.userHeightNatural),
      commentTop: rowTop + layout.userHeightNatural + layout.commentUserGapNatural,
      commentHeight,
      commentFadeSize,
      visible: visible ? 1 : 0,
      occupiesSlot: visible && height >= layout.slotMinimumHeight ? 1 : 0,
      emphasis: peeking && i === pointedAncestor ? 1 : 0,
      gutterTop,
      gutterBottom,
      gutterVisible: gutterVisible ? 1 : 0,
      gutterEmphasis: onGutter && i === pointedAncestor ? 1 : 0,
    })
    const visibleMargin = Math.min(Math.abs(rowTop - scrollerHeight), Math.abs(rowBottom))
    const gutterSelectMargin = Math.min(Math.abs(rowBottom - (userTop + userHeight) - 4), Math.abs(userTop - rowTop - 4))
    visibleMargins.push(visibleMargin)
    occupancyMargins.push(Math.min(visibleMargin, Math.abs(height - layout.slotMinimumHeight)))
    gutterSelectMargins.push(gutterSelectMargin)
    gutterVisibleMargins.push(Math.min(Math.abs(gutterTop - scrollerHeight), gutterSelectMargin))
    rowTop += height
  }
  const placeholderHeight = rowTop + scrollTopCap

  const slots: SlotFrame[] = []
  const slotOf = (index: number): SlotFrame => {
    const row = rows[index]!
    return {
      present: 1,
      row: index,
      userTop: row.userTop,
      userHeight: row.userHeight,
      userOpacity: row.userOpacity,
      userTextOpacity: row.userTextOpacity,
      commentTop: row.commentTop,
      commentHeight: row.commentHeight,
      commentFadeSize: row.commentFadeSize,
      emphasis: row.emphasis,
      collapsed: row.collapsed,
    }
  }
  const emptySlot = (): SlotFrame => ({present: 0, row: 0, userTop: 0, userHeight: 0, userOpacity: 0, userTextOpacity: 0, commentTop: 0, commentHeight: 0, commentFadeSize: 0, emphasis: 0, collapsed: 0})
  let slotOverflow = false
  if (slotMode === 'rank') {
    let occupiedCount = 0
    for (let i = 0; i < rowCount; i++) {
      if (rows[i]!.occupiesSlot === 0) continue
      if (occupiedCount < slotCount) slots.push(slotOf(i))
      occupiedCount++
    }
    slotOverflow = occupiedCount > slotCount
  } else if (slotMode === 'window') {
    const first = rows.findIndex(row => row.visible === 1)
    let visibleCount = 0
    for (const row of rows) visibleCount += row.visible
    for (let slot = 0; slot < slotCount; slot++) {
      const index = first + slot
      slots.push(first >= 0 && index < rowCount && rows[index]!.visible === 1 ? slotOf(index) : emptySlot())
    }
    slotOverflow = visibleCount > slotCount
  }
  while (slots.length < slotCount) slots.push(emptySlot())

  // hn.js 540-560: cursor
  let cursorCode = 0
  let cursorMargin = Infinity
  if (pointerOn === pointerOnCode.row) {
    cursorCode = toggleRegion === 1 ? 5 : 1
  } else if (onGutter) {
    let ancestorTop = 0
    for (let i = 0; i < pointedAncestor; i++) ancestorTop += nextHeights[i]!
    cursorMargin = Math.abs(ancestorTop - scrollTopCap)
    if (ancestorTop < scrollTopCap || pointedAncestor < pointedRow - 1) cursorCode = 2
  } else if (pointerOn === pointerOnCode.threadPrevious) {
    cursorCode = 3
  } else if (pointerOn === pointerOnCode.threadNext) {
    cursorCode = 4
  }

  const frame: ThreadFrame = {
    global: {
      scrollTop,
      scrollTopCap,
      containerWidth,
      containerLeft,
      containerHeight: currentContainerHeight,
      submissionHeight,
      submissionLine1Top,
      submissionLine2Top: submissionLine1Top + layout.submissionLine1Height + submissionLinesGap,
      searchLeft: containerWidth - layout.searchWidth - layout.commentLeftGap,
      searchTop: (submissionHeight - layout.searchHeight) / 2,
      scrollerTop,
      scrollerHeight,
      scrollerPeekUp: nextScrollerPeekUp,
      placeholderHeight,
      pointerOn,
      pointedRow,
      ancestor: pointedAncestor,
      toggleRegion,
      peeking: peeking ? 1 : 0,
      cursorCode,
      scheduleNextRender: scheduleNextRender ? 1 : 0,
      slotOverflow: slotOverflow ? 1 : 0,
    },
    rows,
    slots,
    next: {
      scrollTopPrevious: scrollTop,
      scrollDeltaPrevious: nextScrollDeltaPrevious,
      scrollerPeekUp: nextScrollerPeekUp,
      containerWidthPrevious: containerWidth,
      collapsed: nextCollapsed,
      restHeights: nextRestHeights,
      heights: nextHeights,
      restTargetsPrevious: naturalHeights,
    },
  }
  return {
    frame,
    margins: {
      smoothing: smoothingMargin,
      fits: fitsMargin,
      overscroll: overscrollMargin,
      hit: hitMargin,
      toggle: toggleMargin,
      peekMoving: peekMovingMargin,
      widthChanged: widthChangedMargin,
      moving: movingMargin,
      cursor: cursorMargin,
      visible: visibleMargins,
      occupancy: occupancyMargins,
      gutterSelect: gutterSelectMargins,
      gutterVisible: gutterVisibleMargins,
    },
    branches: {fits: fitsBranch, smoothing: Math.abs(state.scrollDeltaPrevious) > 0.01, widthChanged},
  }
}
