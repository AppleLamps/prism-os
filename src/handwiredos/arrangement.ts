// The rectangles that HandwiredOS's three windows open at, chosen for the viewport.
//
// The program's table holds one rectangle per window, initially the upper left
// 1210 × 620 px of any viewport. Values written into the table before the machine's
// first step commit with the mount, so the page writes other rectangles there, and
// the program and its tests stay as they are. Each window's stored rectangle and its
// springs' destinations are written together, so the windows start at rest.
//
// The arrangement has four forms, by the workspace's size:
// - From 1000 px wide, the desk: Monitor in a column of its own at the left, Notes
//   beside it, and Photos over Notes' right part, so the paragraph starts out flowing
//   around Photos. Monitor is as tall as the other two together, since a list is
//   worth every row that it can show. At 1440 × 900 the rectangles are Monitor
//   38, 84, 540 × 556, Notes 602, 84 and Photos 842, 210, both at the program's
//   default sizes. A larger viewport centers that group, and a smaller one narrows
//   Photos, then Monitor too, and shortens the group.
// - From 640 px wide, two columns: Monitor at the left, and Notes above Photos at
//   the right.
// - Below 640 px wide, e.g. a phone held upright, one column: each window covers the
//   lower part of the window before it, and leaves that window's title bar and Notes'
//   whole paragraph in view.
// - Too short for two rows of windows, e.g. a phone held sideways, one row: each
//   window covers the right part of the window before it.
// Every rectangle is on whole pixels, inside the workspace, and at least the
// program's minimum size, so the program's own clamps leave it as written.
//
// The arrangement looks at what the windows hold, e.g. how many lines Notes' text
// takes in a column, so that a window is covered just under a part of its content.
// Each number of that kind is read from the code that sets it: the title bar's
// height, Photos' gap and the length of Notes' text from the program's table, the
// flow's line height and paddings from notesOptionsFor, and the heights of the
// header and the rows of Monitor's list from monitorLayout.
import {type Wire, invariant} from '../runtime/numeric-ui-core.ts'
import {monitorLayout} from './value-list.ts'
import {defaultLineFitEpsilon, notesOptionsFor} from './notes-paragraph.ts'

export type Rectangle = {left: number, top: number, width: number, height: number}
type Size = {width: number, height: number}

// What the arrangement reads from the program's table besides the workspace and the
// windows' sizes, in px.
export type ArrangementMetrics = {
  // The title bar's height, e.g. 44.
  titleHeight: number
  // How long the text that Notes starts with is on one line, with room to spare, e.g.
  // 1,800 for the starting paragraph, see notesTextWidthOf.
  notesTextWidth: number
  // The gap around and between Photos' photos, e.g. 18.
  photosGap: number
}

// The cells of the window manager's table that the arrangement reads and writes.
type ArrangementCells = {
  systemBarHeight: Wire
  dockHeight: Wire
  minWidth: Wire
  minHeight: Wire
  titleHeight: Wire
  windows: readonly Record<'left' | 'top' | 'width' | 'height', Wire>[]
  springs: readonly Record<'centerX' | 'centerY' | 'width' | 'height', {destination: Wire}>[]
  photos: {gap: Wire}
  // One width cell per segment of Notes' text. The cells after the text hold 0.
  notes: {widths: readonly Wire[]}
}

// Window order, as everywhere in HandwiredOS: Monitor, Notes, Photos.
const windowCount = 3
// A window's content box starts inside the frame's border, which the program builds
// in as 1 px.
const border = 1
// Notes' flow: lines of lineHeight px, which start `padding` px inside the content
// box on every side, and keep verticalPadding px from a window above Notes and
// horizontalPadding px from a window beside the line. None of them depends on the
// line fit epsilon.
const notesFlow = notesOptionsFor(defaultLineFitEpsilon)
// What Notes' frame is wider than its text column: the border and the padding on
// both sides, 50 px.
const notesHorizontalInset = 2 * (border + notesFlow.padding)

// The length of Notes' text on one line, rounded up to the next 100 px. At mount the
// cells hold the baked measurement of the starting paragraph, 1,752 px, which gives
// 1,800. The page's own measurement arrives with the first step, after the windows
// are arranged, and is shorter: 1,567 px in Georgia at 14 px in Chrome on macOS. So
// in the page the text has more room to spare than the rounding adds, e.g. the
// phone's column of 324 px gets 7 lines for a text that takes 5.
function notesTextWidthOf(source: Float32Array, widthCells: readonly Wire[]) {
  let width = 0
  for (const cell of widthCells) width += source[cell]!
  return Math.ceil(width / 100) * 100
}

// How many lines the text takes in a column, plus one line to spare, since each line
// ends at a word boundary.
function notesLinesFor(columnWidth: number, metrics: ArrangementMetrics) {
  return Math.ceil(metrics.notesTextWidth / Math.max(columnWidth, 1)) + 1
}

// A line's top, from the frame's top: the border, the title bar and the flow's
// padding, e.g. 69 px, then one line height per line.
function notesFirstLineTop(metrics: ArrangementMetrics) {
  return border + metrics.titleHeight + notesFlow.padding
}

// The height from Notes' top that `lines` lines need, with nothing above them. A
// window above Notes blocks a line that ends less than verticalPadding px above it.
function notesHeightFor(lines: number, metrics: ArrangementMetrics) {
  return notesFirstLineTop(metrics) + lines * notesFlow.lineHeight + notesFlow.verticalPadding
}

// How much of Monitor stays in view under its top edge in the one-column form,
// when `available` px are left for it: its title bar, the list's header, and as many
// whole rows as fit. The sidebar's heading is as tall as the list's header, and each of
// its locations as tall as a row, so the sidebar is cut between two locations too.
// With less room than the header takes, Monitor shows its title bar alone.
function monitorShownFor(available: number, metrics: ArrangementMetrics) {
  const header = border + metrics.titleHeight + monitorLayout.headerHeight
  if (available < header) return metrics.titleHeight
  return header + Math.floor((available - header) / monitorLayout.rowHeight) * monitorLayout.rowHeight
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

/** @public */
export function arrangeWindows(workspace: Rectangle, minimum: Size, natural: readonly Size[], metrics: ArrangementMetrics): Rectangle[] {
  invariant(natural.length === windowCount, 'the arrangement needs one size per window')
  const sizes = natural as readonly [Size, Size, Size]
  // Two rows of the smallest windows, with the margins around and between them.
  const fitsTwoRows = workspace.height >= 2 * minimum.height + 48
  const rectangles = !fitsTwoRows
    ? arrangeRow(workspace, minimum, sizes, metrics)
    : workspace.width >= 1000
      ? arrangeDesk(workspace, minimum, sizes)
      : workspace.width >= 640
        ? arrangeColumns(workspace, minimum, sizes, metrics)
        : arrangeColumn(workspace, minimum, sizes, metrics)
  return rectangles.map(rectangle => fitInto(rectangle, workspace, minimum))
}

// Rounds to whole pixels and applies the program's own clamps: a size between the
// minimum and the workspace, and a position that keeps the window inside the
// workspace. A workspace smaller than the minimum size gets its own size.
function fitInto(rectangle: Rectangle, workspace: Rectangle, minimum: Size): Rectangle {
  const width = clamp(Math.round(rectangle.width), Math.min(minimum.width, workspace.width), workspace.width)
  const height = clamp(Math.round(rectangle.height), Math.min(minimum.height, workspace.height), workspace.height)
  return {
    left: clamp(Math.round(rectangle.left), workspace.left, workspace.left + workspace.width - width),
    top: clamp(Math.round(rectangle.top), workspace.top, workspace.top + workspace.height - height),
    width,
    height,
  }
}

function arrangeDesk(workspace: Rectangle, minimum: Size, [monitor, notes, photos]: readonly [Size, Size, Size]): Rectangle[] {
  const gap = 24
  const margin = 24
  // Photos starts 240 px right of Notes' left edge and 126 px below Notes' top: two
  // full lines of text above Photos, then a column of 205 px beside it.
  const photosOffsetX = 240
  const photosOffsetY = 126
  // The group at full size: 1364 × 556 px, down to Photos' bottom edge.
  const fullWidth = monitor.width + gap + photosOffsetX + photos.width
  const fullHeight = photosOffsetY + photos.height
  const width = Math.min(fullWidth, workspace.width - 2 * margin)
  const height = Math.min(fullHeight, workspace.height - 2 * margin)
  // The page prints the list of things to try on the desk's lower right, on a
  // workspace of at least 1100 × 738 px, i.e. a viewport of 1100 × 850 px, see
  // .desk-legend in handwired-os.css. There, 160 px stay free under the group where
  // the height allows: the list's 124 px, the 12 px under it, and 24 px above it.
  // Space beyond that is split above and below.
  const legendRoom = workspace.width >= 1100 && workspace.height >= 738 ? 160 - margin : 0
  const spare = Math.max(0, workspace.height - 2 * margin - legendRoom - height)
  const originX = workspace.left + (workspace.width - width) / 2
  const originY = workspace.top + margin + spare / 2

  // A narrower group takes the first 120 px of the missing width from Photos, whose
  // photos are still 87 px wide then, so that Monitor keeps the width that shows
  // the five columns of Operations, e.g. on a viewport 1280 px wide. Past that, half
  // of the missing width comes from Monitor and half from Photos.
  const missing = Math.max(0, fullWidth - width - 120)
  const monitorWidth = Math.max(minimum.width, monitor.width - Math.ceil(missing / 2))
  const notesLeft = monitorWidth + gap
  const photosLeft = notesLeft + photosOffsetX
  const photosWidth = clamp(width - photosLeft, minimum.width, photos.width)
  const photosHeight = clamp(height - photosOffsetY, minimum.height, photos.height)

  return [
    {left: originX, top: originY, width: monitorWidth, height},
    {left: originX + notesLeft, top: originY, width: notes.width, height: Math.min(notes.height, height)},
    {left: originX + photosLeft, top: originY + Math.min(photosOffsetY, height - photosHeight), width: photosWidth, height: photosHeight},
  ]
}

function arrangeColumns(workspace: Rectangle, minimum: Size, [, notes, photos]: readonly [Size, Size, Size], metrics: ArrangementMetrics): Rectangle[] {
  const gap = 16
  const margin = 16
  const columnWidth = Math.floor((workspace.width - 2 * margin - gap) / 2)
  const available = workspace.height - 2 * margin
  // The right column: Notes, as tall as its paragraph needs in this column, with
  // 20 px under the last line, if not taller, above Photos.
  const notesNeeds = Math.max(minimum.height, notesHeightFor(notesLinesFor(columnWidth - notesHorizontalInset, metrics), metrics) + 20)
  const photosHeight = clamp(available - notesNeeds - gap, minimum.height, photos.height)
  const notesHeight = clamp(available - photosHeight - gap, minimum.height, notes.height)
  // The left column: Monitor, as tall as both. The two columns are centered when
  // the workspace is taller than they are.
  const height = notesHeight + gap + photosHeight
  const originY = workspace.top + margin + (available - height) / 2
  const leftColumn = workspace.left + margin
  const rightColumn = leftColumn + columnWidth + gap
  return [
    {left: leftColumn, top: originY, width: columnWidth, height},
    {left: rightColumn, top: originY, width: columnWidth, height: notesHeight},
    {left: rightColumn, top: originY + notesHeight + gap, width: columnWidth, height: photosHeight},
  ]
}

function arrangeColumn(workspace: Rectangle, minimum: Size, [monitor, notes, photos]: readonly [Size, Size, Size], metrics: ArrangementMetrics): Rectangle[] {
  const margin = 8
  const titleBar = metrics.titleHeight
  const width = Math.min(workspace.width - 2 * margin, monitor.width)
  const left = workspace.left + (workspace.width - width) / 2
  const available = workspace.height - 2 * margin
  // What stays in view of each window above the next one. Photos, in front, takes up
  // to 45% of the height, with square photos when that fits: 4 columns and 3 rows of
  // photos with Photos' gap around and between them, under the title bar. Notes shows
  // its whole text where the height allows. Monitor shows the rest: its title bar,
  // the list's header and whole rows, see monitorShownFor.
  const notesNeeds = notesHeightFor(notesLinesFor(width - notesHorizontalInset, metrics), metrics)
  const photoSize = (width - 2 * border - 5 * metrics.photosGap) / 4
  const photosHeight = clamp(
    Math.min(titleBar + 2 * border + 4 * metrics.photosGap + 3 * photoSize, available * 0.45, available - notesNeeds - titleBar),
    minimum.height,
    photos.height,
  )
  const notesShown = Math.max(titleBar, Math.min(notesNeeds, available - photosHeight - titleBar))
  const monitorShown = Math.min(monitorShownFor(available - photosHeight - notesShown, metrics), monitor.height + margin)
  // The column is centered in the height that Monitor's whole rows leave over.
  const height = monitorShown + notesShown + photosHeight
  const monitorTop = workspace.top + margin + Math.max(0, (available - height) / 2)
  const notesTop = monitorTop + monitorShown
  const photosTop = notesTop + notesShown
  const bottom = photosTop + photosHeight
  return [
    {left, top: monitorTop, width, height: Math.min(monitor.height, bottom - monitorTop)},
    {left, top: notesTop, width, height: Math.min(notes.height, bottom - notesTop)},
    {left, top: photosTop, width, height: photosHeight},
  ]
}

function arrangeRow(workspace: Rectangle, minimum: Size, [monitor, notes, photos]: readonly [Size, Size, Size], metrics: ArrangementMetrics): Rectangle[] {
  const margin = 8
  const available = workspace.width - 2 * margin
  const height = Math.min(workspace.height - 2 * margin, monitor.height)
  const top = workspace.top + (workspace.height - height) / 2
  // What stays in view of each window left of the next one. Photos, in front, is as
  // narrow as a window gets. Notes shows a column wide enough for its paragraph in
  // the lines that fit this height, where the width allows. Monitor shows the
  // rest, at least 88 px of its title bar.
  const shownAtLeast = 88
  const photosWidth = Math.min(minimum.width, available)
  const lines = Math.max(2, Math.floor((height - notesFirstLineTop(metrics) - border) / notesFlow.lineHeight))
  // The column, the border and the padding before it, 25 px, and the 10 px that a
  // line keeps from Photos.
  const notesNeeds = Math.ceil(metrics.notesTextWidth / (lines - 1)) + border + notesFlow.padding + notesFlow.horizontalPadding
  const notesShown = Math.max(shownAtLeast, Math.min(notesNeeds, available - photosWidth - shownAtLeast))
  const monitorShown = clamp(available - photosWidth - notesShown, shownAtLeast, monitor.width + margin)
  const width = monitorShown + notesShown + photosWidth
  const monitorLeft = workspace.left + margin + Math.max(0, (available - width) / 2)
  const notesLeft = monitorLeft + monitorShown
  const photosLeft = notesLeft + notesShown
  const right = photosLeft + photosWidth
  return [
    {left: monitorLeft, top, width: Math.min(monitor.width, right - monitorLeft), height},
    {left: notesLeft, top, width: Math.min(notes.width, right - notesLeft), height},
    {left: photosLeft, top, width: Math.min(photos.width, photosWidth), height},
  ]
}

// Chooses the windows' rectangles for the viewport and writes them into the window
// manager's table: each window's stored rectangle, and the destinations of its
// center, width and height springs. Call it before the machine's first step, with
// the viewport's size as that step gets it. The sizes that the table holds, e.g.
// 560 × 430 for Photos, are the windows' sizes on a viewport with room for them,
// except for Monitor's height, which follows the other two windows on a viewport
// wide enough for two columns. The text that Notes' cells hold is the text that the
// windows are arranged for.
export function arrangeInitialWindows(source: Float32Array, cells: ArrangementCells, viewportWidth: number, viewportHeight: number) {
  invariant(cells.windows.length === windowCount && cells.springs.length === windowCount, 'the arrangement needs the cells of every window')
  // The workspace, as the program computes it: below the system bar and above the dock.
  const dockTop = viewportHeight - Math.min(source[cells.dockHeight]!, viewportHeight)
  const workspaceTop = Math.min(source[cells.systemBarHeight]!, dockTop)
  const workspace = {left: 0, top: workspaceTop, width: viewportWidth, height: dockTop - workspaceTop}
  const minimum = {width: source[cells.minWidth]!, height: source[cells.minHeight]!}
  const natural = cells.windows.map(window => ({width: source[window.width]!, height: source[window.height]!}))
  const metrics = {
    titleHeight: source[cells.titleHeight]!,
    notesTextWidth: notesTextWidthOf(source, cells.notes.widths),
    photosGap: source[cells.photos.gap]!,
  }
  const rectangles = arrangeWindows(workspace, minimum, natural, metrics)
  rectangles.forEach((rectangle, windowIndex) => {
    const window = cells.windows[windowIndex]!
    const springs = cells.springs[windowIndex]!
    source[window.left] = rectangle.left
    source[window.top] = rectangle.top
    source[window.width] = rectangle.width
    source[window.height] = rectangle.height
    source[springs.centerX.destination] = rectangle.left + rectangle.width / 2
    source[springs.centerY.destination] = rectangle.top + rectangle.height / 2
    source[springs.width.destination] = rectangle.width
    source[springs.height.destination] = rectangle.height
  })
  return rectangles
}
