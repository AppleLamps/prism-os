// The rectangles that HandwiredOS's four windows open at, chosen for the viewport.
//
// The program's table holds one rectangle per window, initially the upper left
// 1210 × 644 px of any viewport. Values written into the table before the machine's
// first step commit with the mount, so the page writes other rectangles there, and
// the program and its tests stay as they are. Each window's stored rectangle and its
// springs' destinations are written together, so the windows start at rest.
//
// The arrangement has four forms, by the workspace's size:
// - From 1000 px wide, the desk: Files at the top left, Notes beside it, Photos over
//   Notes' right part, so the paragraph starts out flowing around Photos, and Monitor
//   below Files. At 1440 × 900 the rectangles are the design's: Files 48, 60, Notes
//   592, 60, Monitor 248, 440 and Photos 832, 186, at the program's default sizes. A
//   larger viewport centers that group, and a smaller one narrows Files and Photos
//   and shortens the left column.
// - From 640 px wide, a grid of two columns: Files and Notes above Monitor and Photos.
// - Below 640 px wide, e.g. a phone held upright, one column: each window covers the
//   lower part of the window before it, and leaves that window's title bar and Notes'
//   whole paragraph in view.
// - Too short for two rows of windows, e.g. a phone held sideways, one row: each
//   window covers the right part of the window before it.
// Every rectangle is on whole pixels, inside the workspace, and at least the
// program's minimum size, so the program's own clamps leave it as written.
import {type Wire, invariant} from '../runtime/numeric-ui-core.ts'

export type Rectangle = {left: number, top: number, width: number, height: number}
type Size = {width: number, height: number}

// The cells of the window manager's table that the arrangement reads and writes.
type ArrangementCells = {
  systemBarHeight: Wire
  dockHeight: Wire
  minWidth: Wire
  minHeight: Wire
  windows: readonly Record<'left' | 'top' | 'width' | 'height', Wire>[]
  springs: readonly Record<'centerX' | 'centerY' | 'width' | 'height', {destination: Wire}>[]
}

// Window order, as everywhere in HandwiredOS.
const windowCount = 4

// The Notes paragraph is about 1,770 px long on one line, in Georgia at 14 px and in
// the tests' font alike. The arrangement leaves room for a little more.
const notesTextWidth = 1_800
// Notes' text starts 24 px inside its content box, which is 1 px inside the frame,
// and the column ends 24 px before the content box's right edge.
const notesHorizontalInset = 50
// A line's top, from the frame's top: the border, the 44 px title bar and the 24 px
// padding, then 22 px per line. A window above Notes blocks a line that ends less
// than 4 px above it.
const notesFirstLineTop = 69
const notesLineHeight = 22
const notesClearance = 4

// How many lines the paragraph takes in a column, plus one line to spare, since each
// line ends at a word boundary and the page's font may measure a little wider.
function notesLinesFor(columnWidth: number) {
  return Math.ceil(notesTextWidth / Math.max(columnWidth, 1)) + 1
}

// The height from Notes' top that `lines` lines need, with nothing above them.
function notesHeightFor(lines: number) {
  return notesFirstLineTop + lines * notesLineHeight + notesClearance
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

/** @public */
export function arrangeWindows(workspace: Rectangle, minimum: Size, natural: readonly Size[]): Rectangle[] {
  invariant(natural.length === windowCount, 'the arrangement needs one size per window')
  const sizes = natural as readonly [Size, Size, Size, Size]
  // Two rows of the smallest windows, with the margins around and between them.
  const fitsTwoRows = workspace.height >= 2 * minimum.height + 48
  const rectangles = !fitsTwoRows
    ? arrangeRow(workspace, minimum, sizes)
    : workspace.width >= 1000
      ? arrangeDesk(workspace, minimum, sizes)
      : workspace.width >= 640
        ? arrangeGrid(workspace, minimum, sizes)
        : arrangeColumn(workspace, minimum, sizes)
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

function arrangeDesk(workspace: Rectangle, minimum: Size, [files, notes, monitor, photos]: readonly [Size, Size, Size, Size]): Rectangle[] {
  const gap = 24
  const margin = 24
  // Photos starts 240 px right of Notes' left edge and 126 px below Notes' top: two
  // full lines of text above Photos, then a column of 205 px beside it.
  const photosOffsetX = 240
  const photosOffsetY = 126
  // The group at full size: 1344 × 680 px, with 40 px between Files and Monitor.
  const fullWidth = files.width + gap + photosOffsetX + photos.width
  const fullHeight = files.height + 40 + monitor.height
  const width = Math.min(fullWidth, workspace.width - 2 * margin)
  const height = Math.min(fullHeight, workspace.height - 2 * margin)
  // 84 px stay free under the group where the viewport allows, for the list of
  // things to try, which the page prints on the desk's lower right. Space beyond
  // that is split above and below.
  const spare = Math.max(0, workspace.height - margin - 84 - height)
  const originX = workspace.left + (workspace.width - width) / 2
  const originY = workspace.top + margin + spare / 2

  // A narrower group takes half of the missing width from Files and half from Photos.
  const missing = fullWidth - width
  const filesWidth = Math.max(minimum.width, files.width - Math.ceil(missing / 2))
  const notesLeft = filesWidth + gap
  const photosLeft = notesLeft + photosOffsetX
  const photosWidth = clamp(width - photosLeft, minimum.width, photos.width)
  const photosHeight = clamp(height - photosOffsetY, minimum.height, photos.height)

  // The left column: Monitor at the bottom, and Files above it.
  const monitorHeight = clamp(height - minimum.height - gap, minimum.height, monitor.height)
  const monitorTop = height - monitorHeight
  const filesHeight = clamp(monitorTop - gap, minimum.height, files.height)
  // Monitor sits up to 200 px right of Files' left edge, where it can cover Notes'
  // lower left corner, while it starts below the 9 lines that Notes' paragraph may
  // take beside Photos. A shorter group puts Monitor below Files alone, at most as
  // wide as Files.
  const monitorClearsText = monitorTop >= notesHeightFor(9)
  const monitorWidth = monitorClearsText ? monitor.width : Math.min(monitor.width, filesWidth)
  const monitorLeft = monitorClearsText ? clamp(filesWidth - 320, 0, 200) : (filesWidth - monitorWidth) / 2

  return [
    {left: originX, top: originY, width: filesWidth, height: filesHeight},
    {left: originX + notesLeft, top: originY, width: notes.width, height: Math.min(notes.height, height)},
    {left: originX + monitorLeft, top: originY + monitorTop, width: monitorWidth, height: monitorHeight},
    {left: originX + photosLeft, top: originY + Math.min(photosOffsetY, height - photosHeight), width: photosWidth, height: photosHeight},
  ]
}

function arrangeGrid(workspace: Rectangle, minimum: Size, [files, notes, monitor, photos]: readonly [Size, Size, Size, Size]): Rectangle[] {
  const gap = 16
  const margin = 16
  const columnWidth = Math.floor((workspace.width - 2 * margin - gap) / 2)
  const available = workspace.height - 2 * margin
  // The upper row is as tall as Notes' paragraph needs in this column, with 20 px
  // under the last line, if not taller.
  const notesNeeds = Math.max(minimum.height, notesHeightFor(notesLinesFor(columnWidth - notesHorizontalInset)) + 20)
  const lowerHeight = clamp(available - notesNeeds - gap, minimum.height, photos.height)
  const upperHeight = clamp(available - lowerHeight - gap, minimum.height, notes.height)
  // The two rows, centered when the workspace is taller than both.
  const height = upperHeight + gap + lowerHeight
  const originY = workspace.top + margin + (available - height) / 2
  const lowerTop = originY + upperHeight + gap
  const leftColumn = workspace.left + margin
  const rightColumn = leftColumn + columnWidth + gap
  return [
    {left: leftColumn, top: originY, width: columnWidth, height: Math.min(files.height, upperHeight)},
    {left: rightColumn, top: originY, width: columnWidth, height: upperHeight},
    {left: leftColumn, top: lowerTop, width: columnWidth, height: Math.min(monitor.height, lowerHeight)},
    {left: rightColumn, top: lowerTop, width: columnWidth, height: lowerHeight},
  ]
}

function arrangeColumn(workspace: Rectangle, minimum: Size, [files, notes, monitor, photos]: readonly [Size, Size, Size, Size]): Rectangle[] {
  const margin = 8
  const titleBar = 44
  const width = Math.min(workspace.width - 2 * margin, files.width)
  const left = workspace.left + (workspace.width - width) / 2
  const available = workspace.height - 2 * margin
  // What stays in view of each window above the next one. Photos, in front, takes up
  // to 45% of the height, with square photos when that fits: 3 rows between 4 gaps of
  // 18 px, under the title bar. Notes shows its whole paragraph where the height
  // allows. Monitor shows as much as fits of: all of it, its sentence and its three
  // figures, its sentence, or its title bar. Files shows the rest: its title bar,
  // and its content under the bar when the rest holds at least the list's header.
  const notesNeeds = notesHeightFor(notesLinesFor(width - notesHorizontalInset))
  const photoSize = (width - 2 - 5 * 18) / 4
  const photosHeight = clamp(
    Math.min(46 + 4 * 18 + 3 * photoSize, available * 0.45, available - notesNeeds - 2 * titleBar),
    minimum.height,
    photos.height,
  )
  const notesShown = Math.max(titleBar, Math.min(notesNeeds, available - photosHeight - 2 * titleBar))
  const rest = Math.max(2 * titleBar, available - photosHeight - notesShown)
  // From Monitor's top to 10 px under its sentence, which takes one line in a window
  // from 460 px wide, in the system's serif, and two lines in a narrower one. The
  // figures and the 12 px under them take 64 px more.
  const sentence = width >= 460 ? 93 : 113
  const monitorShown = [monitor.height + margin, sentence + 64, sentence].find(shown => shown <= rest - titleBar) ?? titleBar
  // Under Files' title bar, a strip thinner than the list's 28 px header shows the
  // upper half of one line of letters, e.g. 10 px at 390 × 844. Files then shows its
  // title bar alone, and the column is centered in the height that the strip took.
  const filesHeader = 28
  const filesRest = Math.min(rest - monitorShown, files.height + margin)
  const filesShown = filesRest < titleBar + filesHeader ? titleBar : filesRest
  const height = filesShown + notesShown + monitorShown + photosHeight
  const filesTop = workspace.top + margin + Math.max(0, (available - height) / 2)
  const notesTop = filesTop + filesShown
  const monitorTop = notesTop + notesShown
  const photosTop = monitorTop + monitorShown
  const bottom = photosTop + photosHeight
  return [
    {left, top: filesTop, width, height: Math.min(files.height, bottom - filesTop)},
    {left, top: notesTop, width, height: Math.min(notes.height, bottom - notesTop)},
    {left, top: monitorTop, width, height: Math.min(monitor.height, bottom - monitorTop)},
    {left, top: photosTop, width, height: photosHeight},
  ]
}

function arrangeRow(workspace: Rectangle, minimum: Size, [files, notes, monitor, photos]: readonly [Size, Size, Size, Size]): Rectangle[] {
  const margin = 8
  const available = workspace.width - 2 * margin
  const height = Math.min(workspace.height - 2 * margin, monitor.height)
  const top = workspace.top + (workspace.height - height) / 2
  // What stays in view of each window left of the next one. Photos, in front, is as
  // narrow as a window gets. Notes shows a column wide enough for its paragraph in
  // the lines that fit this height, where the width allows. Files and Monitor share
  // the rest, and each keeps at least 88 px of its title bar.
  const shownAtLeast = 88
  const photosWidth = Math.min(minimum.width, available)
  const lines = Math.max(2, Math.floor((height - notesFirstLineTop - 1) / notesLineHeight))
  // The column, the 25 px before it, and the 10 px that a line keeps from Monitor.
  const notesNeeds = Math.ceil(notesTextWidth / (lines - 1)) + 35
  const notesShown = Math.max(shownAtLeast, Math.min(notesNeeds, available - photosWidth - 2 * shownAtLeast))
  const rest = Math.max(2 * shownAtLeast, available - photosWidth - notesShown)
  const filesShown = clamp(rest * 0.4, shownAtLeast, files.width + margin)
  const monitorShown = clamp(rest - filesShown, shownAtLeast, monitor.width + margin)
  const width = filesShown + notesShown + monitorShown + photosWidth
  const filesLeft = workspace.left + margin + Math.max(0, (available - width) / 2)
  const notesLeft = filesLeft + filesShown
  const monitorLeft = notesLeft + notesShown
  const photosLeft = monitorLeft + monitorShown
  const right = photosLeft + photosWidth
  return [
    {left: filesLeft, top, width: Math.min(files.width, right - filesLeft), height},
    {left: notesLeft, top, width: Math.min(notes.width, right - notesLeft), height},
    {left: monitorLeft, top, width: Math.min(monitor.width, right - monitorLeft), height},
    {left: photosLeft, top, width: Math.min(photos.width, photosWidth), height},
  ]
}

// Chooses the windows' rectangles for the viewport and writes them into the window
// manager's table: each window's stored rectangle, and the destinations of its
// center, width and height springs. Call it before the machine's first step. The
// sizes that the table holds, e.g. 520 × 340 for Files, are the windows' sizes on a
// viewport with room for them.
export function arrangeInitialWindows(source: Float32Array, cells: ArrangementCells, viewportWidth: number, viewportHeight: number) {
  invariant(cells.windows.length === windowCount && cells.springs.length === windowCount, 'the arrangement needs the cells of every window')
  // The workspace, as the program computes it: below the system bar and above the dock.
  const dockTop = viewportHeight - Math.min(source[cells.dockHeight]!, viewportHeight)
  const workspaceTop = Math.min(source[cells.systemBarHeight]!, dockTop)
  const workspace = {left: 0, top: workspaceTop, width: viewportWidth, height: dockTop - workspaceTop}
  const minimum = {width: source[cells.minWidth]!, height: source[cells.minHeight]!}
  const natural = cells.windows.map(window => ({width: source[window.width]!, height: source[window.height]!}))
  const rectangles = arrangeWindows(workspace, minimum, natural)
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
