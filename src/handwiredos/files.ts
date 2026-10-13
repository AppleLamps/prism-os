// The Files window, in the same circuit as the window manager: a sidebar of three
// locations, each a virtualized list of rows of one height, scrolled by a native
// scroller.
//
// The program holds no row. JavaScript keeps each row's text in arrays, and the
// program computes which row each of 64 DOM slots shows, from the scroll position
// that the host reads from the scroller at the top of a frame. Row r is drawn in
// slot r % 64, so a row keeps its DOM node while it stays drawn, and rows are
// positioned in the scroller's content coordinates, so the browser moves them
// while scrolling. One integer state cell holds the selected row, and three state
// bits the location, which selects the row count among three cells.
//
// Behavior choices:
// - The scroll position is browser state that the program only reads
//   (chenguini's Scrolling.md). After a key, the program asks the host to scroll
//   so that the selected row is in view, with the scrollTarget and scrollRequest
//   outputs, and the host writes the scroller's position after its DOM writes.
// - The list has a fixed number of DOM slots (behavior-choices.md's "A fixed
//   maximum with a named fallback"). When the viewport needs more rows than
//   slots, the rows past the last slot get no node, and slotOverflow is 1.
// - A row is selected at a release over the list after a press on the list, like
//   HandwiredOS's buttons. A press alone selects nothing, so the press that starts
//   a touch scroll, which the browser ends with a pointercancel, selects nothing.
// - Another location starts with no row selected and at the top: the program
//   clears the selection and asks the host to scroll to 0.
//
// FP32: the scroll position is at most 2,400,000 px on a 1/4 px grid, which is
// within the 2^24 grid steps that FP32 holds exactly. The row at the top of the
// view comes from a rounded quotient and one exact comparison, see
// emitFloorDivide. A release's y is added to the offset inside the first row in
// view, and never to the scroll position: FP32 holds a 1/64 px pointer coordinate
// only up to 262,144 px.
import {
  type Circuit,
  type Wire,
  assertWire,
  emitClampExact,
  emitCompare,
  emitMaximumExact,
  emitMinimumExact,
  emitMultiply,
  emitSelect,
  invariant,
  validateWireView,
} from '../runtime/numeric-ui-core.ts'
import {
  type CellWires,
  type SourceTable,
  createSourceTable,
  event,
  input,
  inputBit,
  list,
  oneHot,
  state,
  stateBit,
} from '../runtime/cells.ts'

// The Files window's index among HandwiredOS's windows.
export const filesWindowIndex = 0

// Whole pixels, built into weights.
export const rowHeight = 24
// DOM slots, a power of two, so that a row's slot is the row's lowest 6 bits.
export const slotCount = 64
// The most rows that the program accepts. The row count is a cell.
export const rowCapacity = 100_000
// Rows drawn above and below the rows in view, so that a scroll that the
// compositor shows before the next frame runs still finds rows at the edges.
const overscanRows = 2
// The machine floors the scroller's position onto this grid, e.g. Chrome reports
// 0.5 px steps at devicePixelRatio 2 and 0.25 px steps at 4.
export const scrollGrid = 1 / 4
// The largest scroll position, which the scrollTop cell's range ends at.
export const maximumScrollTop = rowCapacity * rowHeight
// HandwiredOS's pointer coordinates and window geometry lie on this grid.
const pixelGrid = 1 / 64
const maximumViewportHeight = 16_384
// The sidebar's locations: State, Operations and Outputs. The window opens on
// Operations, the longest list.
export const locationCount = 3
const initialLocation = 1

// Files' layout inside its content box, in px. window-manager.ts builds the hit
// rectangles from these numbers, and the renderer gives them to the DOM at mount.
export const filesLayout = {
  // The sidebar at the content box's left edge. The list takes the rest.
  sidebarWidth: 132,
  // Each location is a rectangle of locationHeight, locationInset from the sidebar's
  // left and right edges, and the first one starts locationTop below the content
  // box's top edge.
  locationInset: 8,
  locationTop: 40,
  locationHeight: 28,
  // The header row above the scroller.
  headerHeight: 28,
  rowHeight,
  // A strip at the list's right edge where the native scrollbar is drawn. A press
  // or a release there is on no row.
  scrollbarStrip: 16,
} as const

invariant(Number.isInteger(Math.log2(slotCount)), 'slotCount must be a power of two')
// Sums of a scroll position, a viewport height and a row height stay within the
// 2^24 grid steps that FP32 holds exactly.
invariant(
  maximumScrollTop + maximumViewportHeight + rowHeight < 2 ** 24 * scrollGrid,
  'the row capacity times the row height, plus the viewport, must stay below 2^24 steps of the scroll grid',
)

const keyNames = ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'] as const
export type FilesKey = (typeof keyNames)[number]

// Files' own cells. A host declares them once, e.g. nested as {files: filesCells}
// in HandwiredOS, adds the rule for filesKeys, and passes the cells' wires to
// buildFiles.
export const filesCells = {
  // The scroller's scrollTop as the DOM reported it at the top of the frame, floored
  // onto the scroll grid and clamped into this range by the machine. The machine
  // writes it before every evaluation, like the spring matrix.
  scrollTop: input([0, maximumScrollTop], {grid: scrollGrid}),
  // Each location's number of rows, which the host writes once, before the first
  // step.
  rowCounts: list(locationCount, () => input([0, rowCapacity], {grid: 1})),
  keys: {
    up: event({grid: 1}),
    down: event({grid: 1}),
    pageUp: event({grid: 1}),
    pageDown: event({grid: 1}),
    home: event({grid: 1}),
    end: event({grid: 1}),
  },
  // The location that the list shows. Only the validator checks the group: with 3
  // members, the sums over it are too short for the compiler to lower to gathers.
  location: oneHot(list(locationCount, index => stateBit(Number(index === initialLocation), {grid: 1})), {declareToCircuit: false}),
  // The selected row of that location, or -1 for none.
  selected: state([-1, rowCapacity - 1], {initial: -1, grid: 1}),
}
type FilesCells = CellWires<typeof filesCells>

// Files' key cells. A later key within one evaluation replaces an earlier one, so
// at most one of them is 1, e.g. table.atMostOne('files keys', filesKeys(cells.files)).
export function filesKeys(cells: FilesCells) {
  return keyNames.map(name => cells.keys[name])
}

// The host's wires that Files reads.
type FilesHost = {
  // The list viewport's height at the window's destination, i.e. the content box's
  // height minus the header row, within 0..16,384 on the 1/64 px grid.
  viewportHeight: Wire
  // Whether Files is the focused window after this evaluation's events, which is
  // when Files takes keys.
  focused: Wire
  // A release over the list after a press on the list, and the release's y relative
  // to the list viewport's top edge, on a grid of 1/64 px or finer.
  listClick: {active: Wire, y: Wire}
  // Per location, a release over the location's sidebar item after a press on it.
  // At most one is 1.
  locationClicks: readonly Wire[]
}

// Per DOM slot: the row that the slot shows, the row's top in the scroller's
// content coordinates, whether the slot is drawn, and whether its row is selected.
export const slotField = {row: 0, top: 1, present: 2, selected: 3, size: 4} as const

// What buildFiles returns, e.g. HandwiredOS's output.files.
export type FilesOutputs = {
  // The height of every row together, which the host gives the scroller's spacer.
  totalHeight: Wire
  // The scroll position that the slots are computed for: the scrollTop cell, or
  // the list's largest scroll position at the window's destination when the cell
  // is past it, e.g. right after the window grew, before the browser clamped the
  // scroller's position.
  scroll: Wire
  // After a key, the scroll position that shows the whole selected row, 0 when a
  // release shows another location, and otherwise `scroll`. scrollRequest is 1 when
  // scrollTarget differs from `scroll`, and the host then scrolls to scrollTarget.
  scrollTarget: Wire
  scrollRequest: Wire
  // 1 when more rows are in view than there are slots, so some get no DOM node.
  slotOverflow: Wire
  // The selected row after this evaluation's events, or -1.
  selected: Wire
  // The location after this evaluation's events: one bit per location, of which
  // exactly one is 1. The host shows that location's rows.
  locations: Wire[]
  slots: Wire[]
}

// FP32 values within 2^23..2^24 are whole numbers, so adding this number and
// subtracting it again rounds to the nearest whole number.
const roundingBase = 2 ** 23 + 2 ** 22

// JS: Math.round(value), for |value| < 2^22, except that a value halfway between
// two whole numbers goes to the even one, as FP32 addition rounds. Two operations,
// each a rounding point that a backend must evaluate in FP32 as written.
function emitRound(circuit: Circuit, value: Wire, minimum: number, maximum: number): Wire {
  const shifted = circuit.roundAffine([[value, 1]], roundingBase)
  const rounded = circuit.roundAffine([[shifted, 1]], -roundingBase)
  circuit.markRoundingPoint(shifted)
  circuit.markRoundingPoint(rounded)
  circuit.assumeRange(rounded, minimum, maximum)
  circuit.assumeGrid(rounded, 1)
  return rounded
}

// JS: Math.floor(value / divisor), for a value within 0..maximum on a declared grid
// and a whole-number divisor, e.g. the row at scroll position 1000 with 24 px rows
// is 41. A plain floor of f(f(1 / divisor) × value) is wrong where the rounded
// product lands on the wrong side of a whole number, e.g. at value 41 for divisor
// 41. Here the product is rounded to the nearest whole number instead, which is
// the floor or the floor plus one, since the product is within a small fraction of
// the true quotient, and one exact comparison of rounded × divisor with the value
// removes the extra one. 7 operations.
function emitFloorDivide(circuit: Circuit, value: Wire, divisor: number, maximum: number): Wire {
  invariant(Number.isInteger(divisor) && divisor >= 1, 'the divisor must be a whole number')
  const approximate = circuit.roundAffine([[value, 1 / divisor]])
  const rounded = emitRound(circuit, approximate, 0, Math.floor(maximum / divisor) + 1)
  const tooLarge = emitCompare(circuit, circuit.affine([[rounded, divisor]]), '>', value)
  const floor = circuit.roundAffine([[rounded, 1], [tooLarge, -1]])
  circuit.assumeRange(floor, 0, Math.floor(maximum / divisor))
  circuit.assumeGrid(floor, 1)
  return floor
}

// JS: Math.floor(value / 2 ** bits), for a whole number within 0..maximum. The
// fraction of value / 2 ** bits is a multiple of 2 ** -bits, so subtracting just
// under a half and rounding gives the floor. 3 operations.
function emitFloorShift(circuit: Circuit, value: Wire, bits: number, maximum: number): Wire {
  const shifted = circuit.roundAffine([[value, 2 ** -bits]], 2 ** -(bits + 1) - 0.5)
  return emitRound(circuit, shifted, 0, Math.floor(maximum * 2 ** -bits))
}

// 1 when every bit is 1, otherwise 0, as relu(sum of bits - (count - 1)).
function emitAll(circuit: Circuit, bits: readonly Wire[]): Wire {
  const all = circuit.reglu([], 1, bits.map(bit => [bit, 1] as const), 1 - bits.length)
  circuit.assumeRange(all, 0, 1)
  return all
}

// Builds Files into the host's circuit, pairs Files' state cells with their next
// values, and returns Files' outputs.
export function buildFiles(circuit: Circuit, table: SourceTable, cells: FilesCells, host: FilesHost): FilesOutputs {
  // What Files assumes of the host's wires. In HandwiredOS, the viewport height
  // comes from window geometry that the table check keeps on the 1/64 px grid
  // within the viewport, and the bits are sums and products of exact bits. The
  // builder infers none of that for them, and without declared grids emitCompare
  // would build sign cascades of about 15 operations instead of integer bits of 2.
  invariant(host.locationClicks.length === locationCount, 'one click per location')
  circuit.assumeRange(host.viewportHeight, 0, maximumViewportHeight)
  circuit.assumeGrid(host.viewportHeight, pixelGrid)
  for (const bit of [host.focused, host.listClick.active, ...host.locationClicks]) {
    circuit.assumeRange(bit, 0, 1)
    circuit.assumeGrid(bit, 1)
  }
  const zero = circuit.constant(0)
  const one = circuit.constant(1)

  // A release on a location's sidebar item shows that location.
  // JS: nextLocation = locationClicks.includes(1) ? locationClicks : location
  const anyLocationClick = circuit.affine(host.locationClicks.map(click => [click, 1] as const))
  const nextLocation = cells.location.map((stored, index) => {
    const kept = circuit.reglu([[stored, 1]], 0, [[anyLocationClick, -1]], 1)
    const next = circuit.roundAffine([[kept, 1], [host.locationClicks[index]!, 1]])
    circuit.assumeRange(next, 0, 1)
    return next
  })
  // JS: locationChanged = locationClicks.some((click, index) => click === 1 && location[index] === 0)
  const locationChanged = circuit.roundAffine(cells.location.map((stored, index) =>
    [circuit.reglu([], 1, [[host.locationClicks[index]!, 1], [stored, -1]], 0), 1] as const))
  circuit.assumeRange(locationChanged, 0, 1)
  // JS: rowCount = rowCounts[nextLocation.indexOf(1)]
  const rowCount = circuit.roundAffine(nextLocation.map((bit, index) => [emitMultiply(circuit, bit, cells.rowCounts[index]!), 1] as const))
  circuit.assumeRange(rowCount, 0, rowCapacity)

  // JS: totalHeight = rowCount * rowHeight
  const totalHeight = circuit.roundAffine([[rowCount, rowHeight]])
  // JS: viewportFloor = Math.floor(viewportHeight), viewportCeil = Math.ceil(viewportHeight)
  const viewportFloor = emitRound(circuit, circuit.roundAffine([[host.viewportHeight, 1]], pixelGrid / 2 - 0.5), 0, maximumViewportHeight)
  const viewportCeil = emitRound(circuit, circuit.roundAffine([[host.viewportHeight, 1]], 0.5 - pixelGrid / 2), 0, maximumViewportHeight)
  // The browser's largest scroll position is the total height minus the scroller's
  // height. The floor makes the program's maximum at least the browser's, so the
  // program never clamps a position that the browser reports for this viewport.
  // JS: maximumScroll = Math.max(0, totalHeight - viewportFloor)
  const maximumScroll = circuit.reglu([], 1, [[totalHeight, 1], [viewportFloor, -1]], 0)
  // JS: scroll = Math.min(scrollTop, maximumScroll)
  const scroll = emitMinimumExact(circuit, cells.scrollTop, maximumScroll)
  // The builder infers the grid of an exact minimum, maximum or selection only
  // while its operands' magnitudes add up to at most 2^24 grid steps, and two
  // scroll positions on the 1/4 px grid can add up to more. So each result that a
  // comparison reads next declares its grid here and below.
  circuit.assumeGrid(scroll, scrollGrid)

  // JS: firstVisible = Math.floor(scroll / rowHeight), offsetInRow = scroll % rowHeight
  const firstVisible = emitFloorDivide(circuit, scroll, rowHeight, maximumScrollTop)
  const offsetInRow = circuit.roundAffine([[scroll, 1], [firstVisible, -rowHeight]])
  circuit.assumeRange(offsetInRow, 0, rowHeight - scrollGrid)
  circuit.assumeGrid(offsetInRow, scrollGrid)
  // One past the last row in view.
  // JS: endVisible = Math.ceil((scroll + viewportCeil) / rowHeight)
  const viewEnd = circuit.roundAffine([[scroll, 1], [viewportCeil, 1]], rowHeight - scrollGrid)
  const endVisible = emitFloorDivide(circuit, viewEnd, rowHeight, maximumScrollTop + maximumViewportHeight + rowHeight)
  // JS: firstDrawn = Math.max(0, firstVisible - overscanRows), endDrawn = Math.min(endVisible + overscanRows, rowCount)
  const firstDrawn = circuit.reglu([], 1, [[firstVisible, 1]], -overscanRows)
  const endDrawn = emitMinimumExact(circuit, circuit.roundAffine([[endVisible, 1]], overscanRows), rowCount)
  circuit.assumeGrid(endDrawn, 1)

  // The row under a release. A path that a 0 bit masks still computes, so the
  // release's y is clamped into the viewport's range before the division.
  // JS: clickedRow = firstVisible + Math.floor((clamp(listClick.y, 0, 16384) + offsetInRow) / rowHeight)
  const clickY = emitClampExact(circuit, host.listClick.y, zero, circuit.constant(maximumViewportHeight))
  const clickOffset = circuit.roundAffine([[clickY, 1], [offsetInRow, 1]])
  const clickedRow = circuit.roundAffine([
    [firstVisible, 1],
    [emitFloorDivide(circuit, clickOffset, rowHeight, maximumViewportHeight + rowHeight), 1],
  ])
  // A release below the last row selects nothing.
  // JS: afterClick = listClick.active && clickedRow < rowCount ? clickedRow : selected
  const clickSelects = emitAll(circuit, [host.listClick.active, emitCompare(circuit, clickedRow, '<', rowCount)])
  const afterClick = emitSelect(circuit, clickSelects, cells.selected, clickedRow)
  circuit.assumeGrid(afterClick, 1)

  // Keys move the selection while Files is focused and has rows. A release in the
  // same evaluation applies first. From no selection, ArrowUp, ArrowDown, PageUp
  // and PageDown select the row at the top of the view.
  // JS: pageRows = Math.max(1, Math.floor(viewportFloor / rowHeight))
  const pageRows = emitMaximumExact(circuit, emitFloorDivide(circuit, viewportFloor, rowHeight, maximumViewportHeight), one)
  circuit.assumeGrid(pageRows, 1)
  const anyKey = circuit.affine(keyNames.map(name => [cells.keys[name], 1] as const))
  circuit.assumeRange(anyKey, 0, 1)
  const keyActive = emitAll(circuit, [anyKey, host.focused, emitCompare(circuit, rowCount, '>=', one)])
  const lastRow = circuit.roundAffine([[rowCount, 1]], -1)
  // JS: moved = afterClick >= 0 ? afterClick + down - up + pageRows * (pageDown - pageUp) : firstVisible
  const moved = emitSelect(
    circuit,
    emitCompare(circuit, afterClick, '>=', zero),
    firstVisible,
    circuit.roundAffine([
      [afterClick, 1],
      [cells.keys.down, 1],
      [cells.keys.up, -1],
      [emitMultiply(circuit, cells.keys.pageDown, pageRows), 1],
      [emitMultiply(circuit, cells.keys.pageUp, pageRows), -1],
    ]),
  )
  const withHome = emitSelect(circuit, cells.keys.home, moved, zero)
  const withEnd = emitSelect(circuit, cells.keys.end, withHome, lastRow)
  circuit.assumeGrid(withEnd, 1)
  // JS: afterKeys = keyActive ? clamp(withEnd, 0, rowCount - 1) : afterClick
  const afterKeys = emitSelect(circuit, keyActive, afterClick, emitClampExact(circuit, withEnd, zero, lastRow))
  // The builder adds the ranges of a selection's two sides, while a selection
  // returns one side. Each side is a row or -1: with a key, a row of the list, and
  // otherwise afterClick, which is the stored selection or the row under a
  // release, and a release selects only a row below rowCount.
  circuit.assumeRange(afterKeys, -1, rowCapacity - 1)
  circuit.assumeGrid(afterKeys, 1)
  // A list that got shorter drops a selection past its end, and another location
  // starts with no selection, whatever else the evaluation's events did.
  // JS: nextSelected = locationChanged ? -1 : Math.min(afterKeys, rowCount - 1)
  const selectedInRange = emitMinimumExact(circuit, afterKeys, lastRow)
  circuit.assumeRange(selectedInRange, -1, rowCapacity - 1)
  circuit.assumeGrid(selectedInRange, 1)
  // (selectedInRange + 1) × (1 - locationChanged) - 1
  const nextSelected = circuit.roundAffine([[circuit.reglu([[selectedInRange, 1]], 1, [[locationChanged, -1]], 1), 1]], -1)
  circuit.assumeRange(nextSelected, -1, rowCapacity - 1)
  circuit.assumeGrid(nextSelected, 1)

  // After a key, the nearest scroll position that shows the whole selected row.
  // The row is afterKeys, which is a row whenever a key applies. nextSelected is
  // -1 instead when the same evaluation's release shows another location, and the
  // position of row -1, -24 px, would lie outside keyTarget's range below.
  // JS: revealed = Math.min(Math.max(scroll, (afterKeys + 1) * rowHeight - viewportFloor), afterKeys * rowHeight)
  const selectedTop = circuit.roundAffine([[afterKeys, rowHeight]])
  const lowest = circuit.roundAffine([[selectedTop, 1], [viewportFloor, -1]], rowHeight)
  const atLeastLowest = emitMaximumExact(circuit, scroll, lowest)
  circuit.assumeGrid(atLeastLowest, scrollGrid)
  const revealed = emitMinimumExact(circuit, atLeastLowest, selectedTop)
  circuit.assumeGrid(revealed, scrollGrid)
  // JS: keyTarget = keyActive ? revealed : scroll
  const keyTarget = emitSelect(circuit, keyActive, scroll, revealed)
  // The builder adds the ranges of a selection's two sides. A selection returns
  // one side: `scroll`, or with a key `revealed`, which then lies between the top
  // of the first row and `scroll`'s maximum.
  circuit.assumeRange(keyTarget, 0, maximumScrollTop)
  circuit.assumeGrid(keyTarget, scrollGrid)
  // Another location starts at the top.
  // JS: scrollTarget = locationChanged ? 0 : keyTarget
  const scrollTarget = circuit.reglu([[keyTarget, 1]], 0, [[locationChanged, -1]], 1)
  circuit.assumeRange(scrollTarget, 0, maximumScrollTop)
  circuit.assumeGrid(scrollTarget, scrollGrid)
  // Without a key or another location, both selections return `scroll` itself, so
  // the two are equal in every bit.
  // JS: scrollRequest = scrollTarget !== scroll
  const scrollRequest = circuit.roundAffine([[emitCompare(circuit, scrollTarget, '===', scroll), -1]], 1)
  circuit.assumeRange(scrollRequest, 0, 1)

  // DOM slots: slot s shows the row within firstDrawn..firstDrawn + slotCount - 1
  // whose index % slotCount is s.
  // JS: offset = firstDrawn % slotCount
  const block = emitFloorShift(circuit, firstDrawn, Math.log2(slotCount), rowCapacity)
  const offset = circuit.roundAffine([[firstDrawn, 1], [block, -slotCount]])
  circuit.assumeRange(offset, 0, slotCount - 1)
  const slots: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    // JS: row = firstDrawn - offset + slot + (offset > slot ? slotCount : 0)
    const wraps = emitCompare(circuit, offset, '>', circuit.constant(slot))
    const row = circuit.roundAffine([[firstDrawn, 1], [offset, -1], [wraps, slotCount]], slot)
    circuit.assumeRange(row, 0, rowCapacity + slotCount - 1)
    slots.push(
      row,
      // JS: top = row * rowHeight
      circuit.roundAffine([[row, rowHeight]]),
      // JS: present = row < endDrawn
      emitCompare(circuit, row, '<', endDrawn),
      emitCompare(circuit, row, '===', nextSelected),
    )
  }
  // JS: slotOverflow = endDrawn - firstDrawn > slotCount
  const slotOverflow = emitCompare(circuit, circuit.roundAffine([[endDrawn, 1], [firstDrawn, -1]]), '>', circuit.constant(slotCount))

  table.next(cells.selected, nextSelected)
  table.next(cells.location, nextLocation)
  return {totalHeight, scroll, scrollTarget, scrollRequest, slotOverflow, selected: nextSelected, locations: nextLocation, slots}
}

// Files on its own, in a table that also holds the cells that a host otherwise
// provides: the list viewport's height, whether Files is focused, a release over
// the list with its y, and a release on each location.
/** @public */
export function createFilesCircuit() {
  const table = createSourceTable()
  const cells = table.declare({
    viewportHeight: input([0, maximumViewportHeight], {initial: 266, grid: pixelGrid}),
    focused: inputBit(1),
    listClick: {active: event({grid: 1}), y: input([-49_152, 49_152], {grid: pixelGrid})},
    locationClicks: list(locationCount, () => event({grid: 1})),
    files: filesCells,
  })
  table.atMostOne('files keys', filesKeys(cells.files))
  table.atMostOne('location clicks', cells.locationClicks)
  const circuit = table.createCircuit()
  const files = buildFiles(circuit, table, cells.files, {
    viewportHeight: cells.viewportHeight,
    focused: cells.focused,
    listClick: cells.listClick,
    locationClicks: cells.locationClicks,
  })
  const {nextSource, initialSource, validate} = table.finish()
  return {circuit, cells, output: files, nextSource, initialSource, validate}
}

// What the host shows in the list: a title per text column for the header, each
// row's text, and each row's current value. A row has a name, a kind, a layer and
// a number of stored weights, which never change, and a location leaves a column
// out with an empty title. The value column comes last.
const textColumnNames = ['name', 'kind', 'layer', 'weights'] as const
const kindColumn = textColumnNames.indexOf('kind')
type ColumnTexts = readonly [name: string, kind: string, layer: string, weights: string]
export type FilesLocation = {
  // The sidebar item's text, e.g. 'Operations'. The list's class name ends with it
  // in lower case, e.g. files-list-operations, so the stylesheet can size the
  // location's columns.
  label: string
  titles: ColumnTexts
  rowCount: number
  text: (row: number) => ColumnTexts
  // A class for the row's kind cell, e.g. 'kind-reglu', which the stylesheet draws a
  // color swatch from. A location without one gives its kind cells no such class.
  kindClass?: (row: number) => string
  // The row's value in the last evaluation.
  value: (row: number) => number
}

// An FP32 value as the shortest decimal that reads back as the same FP32 value,
// e.g. '0.1' for f(0.1), whose float64 digits are 0.10000000149011612. 9
// significant digits always identify an FP32 value. A whole number below 10^21,
// where JavaScript still prints every digit, is shown exactly, e.g. 2399976.
export function formatValue(value: number) {
  if (!Number.isFinite(value) || (Number.isInteger(value) && Math.abs(value) < 1e21)) return String(value)
  for (let digits = 1; digits <= 9; digits++) {
    const rounded = Number(value.toPrecision(digits))
    if (Math.fround(rounded) === value) return String(rounded)
  }
  return String(value)
}

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

// The four kinds of live operation that Files and the System Monitor both name,
// each with the text that a row shows and the class that the row's kind cell gets:
// a weighted sum, a ReGLU, a boolean atom and an index read. A sum that the
// compiler lowered to a gather read is still a sum, so it is an affine operation
// in both windows.
const operationKinds = [
  {name: 'affine', className: 'kind-affine'},
  {name: 'ReGLU', className: 'kind-reglu'},
  {name: 'boolean', className: 'kind-boolean'},
  {name: 'index read', className: 'kind-index'},
] as const

// The rows of a compiled program's live operations, in the program's packed order,
// i.e. layer by layer: the operation's wire, its kind, its layer counted from 1,
// and its number of stored weights. A ReGLU's weights include its gate's. An index
// read's are the weights of its index, e.g. 1 for a read at one wire's value: the
// read copies the table entry at that position and stores no weight for the
// entries. A gather read stores no weights. The numbers are kept in typed arrays,
// and a row's text is formatted when a slot shows the row. `packedValues` is the
// array that the program's evaluator computes in, see createTensorProgramEvaluator.
export function describeOperations(program: TensorProgram, packedValues: Float32Array): FilesLocation {
  const rowCount = program.valueCount - program.sourceSize
  const kinds = new Uint8Array(rowCount)
  const layers = new Uint16Array(rowCount)
  const weights = new Uint32Array(rowCount)
  let firstRow = 0
  program.layers.forEach((layer, layerIndex) => {
    const storedWeights = (projectionRow: number) => layer.rowOffsets[projectionRow + 1]! - layer.rowOffsets[projectionRow]!
    for (let output = 0; output < layer.outputSize; output++) {
      layers[firstRow + output] = layerIndex + 1
      weights[firstRow + output] = storedWeights(output)
    }
    for (let gate = 0; gate < layer.gateRows.length; gate++) {
      const row = firstRow + layer.gateRows[gate]!
      kinds[row] = 1
      // A ReGLU's gate is a projection row after the layer's outputs.
      weights[row] = weights[row]! + storedWeights(layer.outputSize + gate)
    }
    for (let index = 0; index < layer.booleanRows.length; index++) kinds[firstRow + layer.booleanRows[index]!] = 2
    for (const read of layer.indexReads) {
      const row = firstRow + read.row
      kinds[row] = 3
      // An index read's index is a projection row after the gates' rows.
      weights[row] = weights[row]! + storedWeights(read.indexRow)
    }
    firstRow += layer.outputSize
  })
  invariant(firstRow === rowCount, 'the layers hold every live operation')
  return {
    label: 'Operations',
    titles: ['wire', 'kind', 'layer', 'weights'],
    rowCount,
    text: row => [
      String(program.wireOrder[program.sourceSize + row]),
      operationKinds[kinds[row]!]!.name,
      String(layers[row]),
      String(weights[row]),
    ],
    kindClass: row => operationKinds[kinds[row]!]!.className,
    value: row => packedValues[program.sourceSize + row]!,
  }
}

// The rows of a source table's cells, in table order: the cell's name from its place
// in the cell declarations, written with dots, e.g. 'windows.3.left' for the table's
// 'windows[3].left', and what happens to the cell around an evaluation, e.g. 'state'.
// The source cells are the first packed values, so a cell's value is the one that
// the last evaluation read, e.g. the spring matrix that the host wrote for it.
export function describeState(cells: readonly {name: string, policy: string}[], packedValues: Float32Array): FilesLocation {
  return {
    label: 'State',
    titles: ['cell', 'kind', '', ''],
    rowCount: cells.length,
    text: row => [cells[row]!.name.replaceAll(/\[(\d+)\]/g, '.$1'), cells[row]!.policy, '', ''],
    value: row => packedValues[row]!,
  }
}

// The rows of the outputs that a page draws from, by name, e.g. 'windows.0.translateX'.
// `values` is the machine's array of root values, indexed by wire.
export function describeOutputs(outputs: readonly {name: string, wire: Wire}[], values: Float32Array): FilesLocation {
  return {
    label: 'Outputs',
    titles: ['output', '', '', ''],
    rowCount: outputs.length,
    text: row => [outputs[row]!.name, '', '', ''],
    value: row => values[outputs[row]!.wire]!,
  }
}

// Creates the sidebar's items, the header's cells and the slots' row nodes inside
// `root`, the Files content box, and returns a frame's DOM read, DOM writes and
// side effect. `locations` holds one entry per location of the program, in order.
export function createFilesRenderer(document: Document, root: HTMLElement, locations: readonly FilesLocation[]) {
  invariant(locations.length === locationCount, 'one entry per location')
  const sidebar = root.querySelector<HTMLElement>('.files-sidebar')
  const list = root.querySelector<HTMLElement>('.files-list')
  const header = root.querySelector<HTMLElement>('.files-header')
  const scroller = root.querySelector<HTMLElement>('.files-scroller')
  const spacer = root.querySelector<HTMLElement>('.files-spacer')
  const overflow = root.querySelector<HTMLElement>('.files-overflow')
  invariant(sidebar !== null, 'Files sidebar is missing')
  invariant(list !== null, 'Files list is missing')
  invariant(header !== null, 'Files header is missing')
  invariant(scroller !== null, 'Files scroller is missing')
  invariant(spacer !== null, 'Files spacer is missing')
  invariant(overflow !== null, 'Files overflow notice is missing')
  // The program's layout numbers, which the stylesheet reads, e.g. for a row's height.
  root.style.setProperty('--files-sidebar-width', `${filesLayout.sidebarWidth}px`)
  root.style.setProperty('--files-header-height', `${filesLayout.headerHeight}px`)
  root.style.setProperty('--files-row-height', `${filesLayout.rowHeight}px`)
  root.style.setProperty('--files-scrollbar-strip', `${filesLayout.scrollbarStrip}px`)
  const createCells = (parent: HTMLElement) => [...textColumnNames, 'value'].map(column => {
    const cell = document.createElement('span')
    cell.className = `files-cell files-cell-${column}`
    parent.appendChild(cell)
    return cell
  })
  overflow.textContent = `Only ${slotCount} rows are drawn at a time.`
  const domCache = {
    list, // mount lifetime
    scroller, // mount lifetime
    spacer, // mount lifetime
    overflow, // mount lifetime
    headerCells: createCells(header), // mount lifetime
    // mount lifetime. Each item sits on the rectangle that the program hit-tests.
    locationNodes: locations.map((location, index) => {
      const node = document.createElement('div')
      node.className = 'files-location'
      node.textContent = location.label
      node.style.left = `${filesLayout.locationInset}px`
      node.style.top = `${filesLayout.locationTop + index * filesLayout.locationHeight}px`
      node.style.width = `${filesLayout.sidebarWidth - 2 * filesLayout.locationInset}px`
      node.style.height = `${filesLayout.locationHeight}px`
      sidebar.appendChild(node)
      return node
    }),
    // The location whose titles the header's cells hold, or -1 before the first
    // frame. Lifetime: until the list shows another location.
    location: -1,
    // The nodes have mount lifetime. Each slot also keeps the row whose text its
    // cells hold, or -1, until the slot shows another row or the list another
    // location, the kind class that its kind cell has, '' for none as at creation,
    // until a row of another kind takes the slot, and the value whose text its last
    // cell holds, until the row's value changes.
    slots: Array.from({length: slotCount}, () => {
      const node = document.createElement('div')
      node.className = 'files-row'
      spacer.appendChild(node)
      return {node, cells: createCells(node), row: -1, kindClass: '', value: Number.NaN}
    }),
  }

  return {
    // A DOM read, for the top of a frame. The machine floors and clamps the position.
    readScrollTop() {
      return domCache.scroller.scrollTop
    },
    // A frame's DOM writes.
    render(values: Float32Array, output: FilesOutputs) {
      const locationIndex = output.locations.findIndex(wire => values[wire] === 1)
      const location = locations[locationIndex]
      invariant(location !== undefined, 'Files shows one location')
      domCache.locationNodes.forEach((node, index) => {
        node.style.setProperty('--selected', `${values[output.locations[index]!]}`)
      })
      if (domCache.location !== locationIndex) {
        // Another location: its column titles, its columns' sizes through the class
        // name, and every slot's text, since a row index now means another row.
        domCache.list.className = `files-list files-list-${location.label.toLowerCase()}`
        domCache.headerCells.forEach((cell, column) => {
          cell.textContent = location.titles[column] ?? 'value'
        })
        for (const slot of domCache.slots) slot.row = -1
        domCache.location = locationIndex
      }
      domCache.spacer.style.height = `${values[output.totalHeight]}px`
      domCache.overflow.style.display = values[output.slotOverflow] === 1 ? 'block' : 'none'
      domCache.slots.forEach((slot, index) => {
        const outputStart = index * slotField.size
        const present = values[output.slots[outputStart + slotField.present]!] === 1
        const row = values[output.slots[outputStart + slotField.row]!]!
        slot.node.style.display = present ? 'grid' : 'none'
        slot.node.style.transform = `translateY(${values[output.slots[outputStart + slotField.top]!]}px)`
        slot.node.style.setProperty('--selected', `${values[output.slots[outputStart + slotField.selected]!]}`)
        if (!present) return
        // A row's text is written only when the slot's row changes: a row keeps its
        // slot while it's drawn, so scrolling by one row writes one row's text. The
        // value's text is written when the row or the value changes, compared with
        // the number kept here rather than with the DOM.
        const rowChanged = slot.row !== row
        if (rowChanged) {
          const text = location.text(row)
          text.forEach((columnText, column) => {
            slot.cells[column]!.textContent = columnText
          })
          // The kind cell's whole class name, written only when the slot's row is of
          // another kind than the row before it, e.g. when a ReGLU follows a sum.
          const kindClass = location.kindClass?.(row) ?? ''
          if (kindClass !== slot.kindClass) {
            slot.cells[kindColumn]!.className = kindClass === '' ? 'files-cell files-cell-kind' : `files-cell files-cell-kind ${kindClass}`
            slot.kindClass = kindClass
          }
          slot.row = row
        }
        const value = location.value(row)
        if (rowChanged || !Object.is(value, slot.value)) {
          slot.cells[textColumnNames.length]!.textContent = formatValue(value)
          slot.value = value
        }
      })
    },
    // A side effect, for after every DOM write of a frame: scrolls the list to
    // `position`, and returns the position read back, which the browser may have
    // rounded or clamped.
    scrollTo(position: number) {
      domCache.scroller.scrollTop = position
      return domCache.scroller.scrollTop
    },
  }
}

export function validateFilesOutputWires(output: FilesOutputs, wireCount: number) {
  for (const wire of [output.totalHeight, output.scroll, output.scrollTarget, output.scrollRequest, output.slotOverflow, output.selected]) {
    assertWire(wire, wireCount)
  }
  validateWireView(output.locations, locationCount, wireCount)
  validateWireView(output.slots, slotCount * slotField.size, wireCount)
}

// The machine checks that every root value is finite before calling this.
export function validateFilesOutput(values: Float32Array, output: FilesOutputs) {
  const isBit = (value: number | undefined) => value === 0 || value === 1
  const totalHeight = values[output.totalHeight]!
  invariant(totalHeight >= 0 && Number.isInteger(totalHeight / rowHeight), `Files total height must be a whole number of rows, got ${totalHeight}`)
  for (const wire of [output.scroll, output.scrollTarget]) {
    invariant(values[wire]! >= 0 && values[wire]! <= maximumScrollTop, `a Files scroll position must be within 0..${maximumScrollTop}, got ${values[wire]}`)
  }
  invariant(isBit(values[output.scrollRequest]), `Files scroll request must equal zero or one, got ${values[output.scrollRequest]}`)
  invariant(isBit(values[output.slotOverflow]), `Files slot overflow must equal zero or one, got ${values[output.slotOverflow]}`)
  const selected = values[output.selected]!
  invariant(Number.isInteger(selected) && selected >= -1, `Files selected row must be a row or -1, got ${selected}`)
  let locationMass = 0
  for (const wire of output.locations) {
    const bit = values[wire]
    invariant(bit === 0 || bit === 1, `a Files location bit must equal zero or one, got ${bit}`)
    locationMass += bit
  }
  invariant(locationMass === 1, `Files must show exactly one location, got ${locationMass}`)
  for (let slot = 0; slot < slotCount; slot++) {
    const outputStart = slot * slotField.size
    const row = values[output.slots[outputStart + slotField.row]!]!
    invariant(Number.isInteger(row) && row >= 0 && row % slotCount === slot, `Files slot ${slot} must show a row whose index % ${slotCount} is ${slot}, got ${row}`)
    invariant(values[output.slots[outputStart + slotField.top]!] === row * rowHeight, `Files slot ${slot} must be at its row's top`)
    invariant(isBit(values[output.slots[outputStart + slotField.present]!]), `Files slot ${slot} present must equal zero or one`)
    invariant(isBit(values[output.slots[outputStart + slotField.selected]!]), `Files slot ${slot} selected must equal zero or one`)
  }
}
