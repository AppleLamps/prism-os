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
//   beside it, and Photos over Notes' lower right part, under the note's first two
//   lines. Monitor is as tall as the other two together, since a list is worth
//   every row that it can show. At 1440 × 900 the rectangles are Monitor
//   38, 152, 540 × 556, Notes 602, 152 and Photos 842, 278, both at the program's
//   default sizes. The group is centered in the workspace, and a smaller viewport
//   narrows Photos, then Monitor too, and shortens the group.
// - From 640 px wide, two columns: Monitor at the left, and Notes above Photos at
//   the right.
// - Below 640 px wide, e.g. a phone held upright, one column: each window covers the
//   lower part of the window before it, and leaves that window's title bar and the
//   note's first lines in view.
// - Too short for two rows of windows, e.g. a phone held sideways, one row: Notes
//   covers the right part of Monitor, and Photos stands beside Notes.
// Every rectangle is on whole pixels, inside the workspace, and at least the
// program's minimum size, so the program's own clamps leave it as written.
//
// The arrangement looks at what the windows hold, so that a window is covered just
// under a part of its content, e.g. Monitor under a whole row of its list. Each
// number of that kind is read from the code that sets it: the title bar's height,
// Photos' gap and the margin around a maximized window from the program's table,
// and the heights of the header and the rows of Monitor's list from monitorLayout.
// The note's text is the browser's to lay out, so the arrangement measures none of
// it: Notes keeps a fixed part of the note in view, see noteShown.
import {type Wire, invariant} from '../runtime/numeric-ui-core.ts'
import {locationCount, monitorLayout} from './value-list.ts'

export type Rectangle = {left: number, top: number, width: number, height: number}
type Size = {width: number, height: number}

// What the arrangement reads from the program's table besides the workspace and the
// windows' sizes, in px.
export type ArrangementMetrics = {
  // The title bar's height, e.g. 44.
  titleHeight: number
  // The gap around and between Photos' photos, e.g. 18.
  photosGap: number
  // The margin that the program keeps between a maximized window and the
  // workspace's edges, e.g. 12.
  maximizedMargin: number
}

// The cells of the window manager's table that the arrangement reads and writes.
type ArrangementCells = {
  systemBarHeight: Wire
  dockHeight: Wire
  minWidth: Wire
  minHeight: Wire
  titleHeight: Wire
  margin: Wire
  windows: readonly Record<'left' | 'top' | 'width' | 'height', Wire>[]
  springs: readonly Record<'centerX' | 'centerY' | 'width' | 'height', {destination: Wire}>[]
  photos: {gap: Wire}
}

// Window order, as everywhere in HandwiredOS: Monitor, Notes, Photos.
const windowCount = 3
// A window's content box starts inside the frame's border, which the program builds
// in as 1 px.
const border = 1
// The least of the note that stays in view under Notes' title bar, where another
// window covers Notes' lower part or Notes is short: 136 px. In the type that
// handwired-os.css gives the note, those are the 24 px above the first line, four
// lines of 22 px, and 24 px under them. The text that the page starts with takes
// three lines in a phone's column, e.g. in the 316 px that the note's lines have
// on a phone 390 px wide, and four in a window at its minimum width.
const noteShown = 136

// How much of Monitor stays in view under its top edge in the one-column form,
// when `available` px are left for it. `whole` is the window's height and the margin
// under it: with that much room, the next window starts under Monitor. Otherwise
// Monitor shows its title bar, the list's header, and as many whole rows as fit, up
// to three. The sidebar's heading is as tall as the list's header, and each of its
// three locations as tall as a row, so the sidebar is cut under a location too, and
// never through the caption that it holds under the locations. With less room than
// the header takes, Monitor shows its title bar alone.
function monitorShownFor(available: number, whole: number, metrics: ArrangementMetrics) {
  if (available >= whole) return whole
  const header = border + metrics.titleHeight + monitorLayout.headerHeight
  if (available < header) return metrics.titleHeight
  return header + Math.min(locationCount, Math.floor((available - header) / monitorLayout.rowHeight)) * monitorLayout.rowHeight
}

// How tall Photos is at most at a width: its title bar, and 4 columns and 3 rows of
// photos with its gap around and between them, where a photo is at most 1.25 times
// as tall as wide. E.g. 319 px at 306 px of width, and more than the default 430 px
// from 425 px of width, where the default height stays. At its default size, 560 px
// wide, a photo is 117 × 104 px.
function photosTallestFor(width: number, metrics: ArrangementMetrics) {
  const photoWidth = (width - 2 * border - 5 * metrics.photosGap) / 4
  return metrics.titleHeight + 2 * border + 4 * metrics.photosGap + 3 * 1.25 * photoWidth
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
      ? arrangeDesk(workspace, minimum, sizes, metrics)
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

function arrangeDesk(workspace: Rectangle, minimum: Size, [monitor, notes, photos]: readonly [Size, Size, Size], metrics: ArrangementMetrics): Rectangle[] {
  const gap = 24
  const margin = 24
  // Photos starts 240 px right of Notes' left edge and 126 px below Notes' top: the
  // note's first two lines are in view above Photos at their full width, and of the
  // lines after them the first 215 px, beside Photos.
  const photosOffsetX = 240
  const photosOffsetY = 126
  // The group at full size is 1364 px wide.
  const fullWidth = monitor.width + gap + photosOffsetX + photos.width
  const width = Math.min(fullWidth, workspace.width - 2 * margin)
  const originX = workspace.left + (workspace.width - width) / 2

  // A narrower group takes the first 120 px of the missing width from Photos, whose
  // photos are still 87 px wide then, so that Monitor keeps the width that shows
  // the five columns of Operations, e.g. on a viewport 1280 px wide. Past that, half
  // of the missing width comes from Monitor and half from Photos.
  const missing = Math.max(0, fullWidth - width - 120)
  const monitorWidth = Math.max(minimum.width, monitor.width - Math.ceil(missing / 2))
  const notesLeft = monitorWidth + gap
  const photosLeft = notesLeft + photosOffsetX
  const photosWidth = clamp(width - photosLeft, minimum.width, photos.width)

  // A narrower Photos is shorter too, see photosTallestFor, e.g. 306 × 319 px
  // instead of 306 × 430 px. The group is as tall as Notes and Photos together,
  // 556 px at full size, and Monitor is as tall as the group.
  const height = Math.min(photosOffsetY + Math.min(photos.height, photosTallestFor(photosWidth, metrics)), workspace.height - 2 * margin)
  const photosHeight = clamp(height - photosOffsetY, minimum.height, photos.height)
  // The group is centered between the system bar and the dock, like it is centered
  // between the workspace's left and right edges.
  const originY = workspace.top + (workspace.height - height) / 2

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
  // The right column: Notes above Photos. Photos is as tall as the room under the
  // least that Notes shows of the note, up to the height that keeps its photos from
  // getting tall and thin, and Notes takes the rest, up to its own height.
  const notesNeeds = Math.max(minimum.height, 2 * border + metrics.titleHeight + noteShown)
  const photosHeight = clamp(Math.min(available - notesNeeds - gap, photosTallestFor(columnWidth, metrics)), minimum.height, photos.height)
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

// In one column and in one row, the windows keep the margin of a maximized window
// from the workspace's edges, 12 px. A maximized window then covers the windows
// behind it. With a margin of 8 px, a window maximized on a phone left 4 px of the
// other two in view on each side.
function arrangeColumn(workspace: Rectangle, minimum: Size, [monitor, notes, photos]: readonly [Size, Size, Size], metrics: ArrangementMetrics): Rectangle[] {
  const margin = metrics.maximizedMargin
  const titleBar = metrics.titleHeight
  const width = Math.min(workspace.width - 2 * margin, monitor.width)
  const left = workspace.left + (workspace.width - width) / 2
  const available = workspace.height - 2 * margin
  // What stays in view of each window above the next one. Photos, in front, takes up
  // to 45% of the height, with square photos when that fits: 4 columns and 3 rows of
  // photos with Photos' gap around and between them, under the title bar. Monitor
  // shows its title bar, the list's header and up to three rows, see
  // monitorShownFor, in the room that Photos and the least of Notes leave, i.e. Notes'
  // title bar and the first lines of the note, see noteShown. Notes shows the rest,
  // up to its whole height.
  const notesLeast = border + titleBar + noteShown
  const photoSize = (width - 2 * border - 5 * metrics.photosGap) / 4
  const photosHeight = clamp(
    Math.min(titleBar + 2 * border + 4 * metrics.photosGap + 3 * photoSize, available * 0.45, available - notesLeast - titleBar),
    minimum.height,
    photos.height,
  )
  const monitorShown = monitorShownFor(available - photosHeight - notesLeast, monitor.height + margin, metrics)
  const notesShown = Math.max(titleBar, Math.min(available - photosHeight - monitorShown, notes.height + margin))
  // The column is centered in the height that is left over, e.g. on a viewport too
  // short for Monitor's header.
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
  const margin = metrics.maximizedMargin
  const available = workspace.width - 2 * margin
  const height = Math.min(workspace.height - 2 * margin, monitor.height)
  const top = workspace.top + (workspace.height - height) / 2
  // Photos, in front, is as narrow as a window gets. Notes stands left of it, whole,
  // since a window over the note would cover the ends of its lines: it is as wide
  // as the room that Photos and a whole Monitor leave, between the minimum width and
  // its own. Monitor shows the rest left of Notes, at least 88 px of its title bar,
  // and where even that is too much, Photos covers the right part of Notes.
  const shownAtLeast = 88
  const photosWidth = Math.min(minimum.width, available)
  const notesWidth = clamp(available - photosWidth - (monitor.width + margin), minimum.width, notes.width)
  const notesShown = Math.max(shownAtLeast, Math.min(notesWidth, available - photosWidth - shownAtLeast))
  const monitorShown = clamp(available - photosWidth - notesShown, shownAtLeast, monitor.width + margin)
  const width = monitorShown + notesShown + photosWidth
  const monitorLeft = workspace.left + margin + Math.max(0, (available - width) / 2)
  const notesLeft = monitorLeft + monitorShown
  const photosLeft = notesLeft + notesShown
  const right = photosLeft + photosWidth
  return [
    {left: monitorLeft, top, width: Math.min(monitor.width, right - monitorLeft), height},
    {left: notesLeft, top, width: notesWidth, height},
    {left: photosLeft, top, width: Math.min(photos.width, photosWidth), height},
  ]
}

// Chooses the windows' rectangles for the viewport and writes them into the window
// manager's table: each window's stored rectangle, and the destinations of its
// center, width and height springs. Call it before the machine's first step, with
// the viewport's size as that step gets it. The sizes that the table holds, e.g.
// 560 × 430 for Photos, are the windows' sizes on a viewport with room for them,
// except for Monitor's height, which follows the other two windows on a viewport
// wide enough for two columns.
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
    photosGap: source[cells.photos.gap]!,
    maximizedMargin: source[cells.margin]!,
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
