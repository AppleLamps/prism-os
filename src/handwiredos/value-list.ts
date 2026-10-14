// The list of the program's own values, which fills HandwiredOS's Monitor window,
// in the same circuit as the window manager: a sidebar of three locations, each a
// virtualized list of rows of one height, scrolled by a native scroller. Under
// both, the window has a footer, which monitor-footer.ts fills.
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

// Whole pixels, built into weights.
export const rowHeight = 24
// DOM slots, a power of two, so that a row's slot is the row's lowest 6 bits.
export const slotCount = 64
// The most rows that the program accepts. The row count is a cell.
export const rowCapacity = 100_000
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

// Monitor's layout inside its content box, in px. window-manager.ts builds the hit
// rectangles from these numbers, and the renderer gives them to the DOM at mount.
export const monitorLayout = {
  // The sidebar at the content box's left edge. The list takes the rest. A sidebar
  // item holds its location's name and row count, e.g. "Operations" and "4,254".
  sidebarWidth: 152,
  // The header row above the scroller, and the sidebar's heading beside it.
  headerHeight: 28,
  rowHeight,
  // Each location is a rectangle of locationHeight, locationInset from the sidebar's
  // left and right edges, and the first one starts locationTop below the content
  // box's top edge. A location is as tall as a row and the first one starts beside
  // the first row, so the sidebar's items and the list's rows share their lines.
  locationInset: 8,
  locationTop: 28,
  locationHeight: rowHeight,
  // A strip at the list's right edge where the native scrollbar is drawn. A press
  // or a release there is on no row.
  scrollbarStrip: 16,
  // The footer along the content box's bottom edge, under the sidebar and the
  // list, where the page shows the program's sizes and the last frames' times. A
  // press or a release there is on no row.
  footerHeight: 32,
} as const

invariant(Number.isInteger(Math.log2(slotCount)), 'slotCount must be a power of two')
// Sums of a scroll position, a viewport height and a row height stay within the
// 2^24 grid steps that FP32 holds exactly.
invariant(
  maximumScrollTop + maximumViewportHeight + rowHeight < 2 ** 24 * scrollGrid,
  'the row capacity times the row height, plus the viewport, must stay below 2^24 steps of the scroll grid',
)

const keyNames = ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'] as const
export type ValueListKey = (typeof keyNames)[number]

// The list's own cells. A host declares them once, e.g. nested as
// {valueList: valueListCells} in HandwiredOS, adds the rule for valueListKeys, and
// passes the cells' wires to buildValueList.
export const valueListCells = {
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
type ValueListCells = CellWires<typeof valueListCells>

// The list's key cells. A later key within one evaluation replaces an earlier one, so
// at most one of them is 1, e.g. table.atMostOne('value list keys',
// valueListKeys(cells.valueList)).
export function valueListKeys(cells: ValueListCells) {
  return keyNames.map(name => cells.keys[name])
}

// The host's wires that the list reads.
type ValueListHost = {
  // The list viewport's height at the window's destination, i.e. the content box's
  // height minus the header row and the footer, within 0..16,384 on the 1/64 px grid.
  viewportHeight: Wire
  // Whether the list's window is the focused window after this evaluation's events,
  // which is when the list takes keys.
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

// What buildValueList returns, e.g. HandwiredOS's output.valueList.
export type ValueListOutputs = {
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

// Builds the list into the host's circuit, pairs the list's state cells with their
// next values, and returns the list's outputs.
export function buildValueList(circuit: Circuit, table: SourceTable, cells: ValueListCells, host: ValueListHost): ValueListOutputs {
  // What the list assumes of the host's wires. In HandwiredOS, the viewport height
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
  // JS: endVisible = Math.min(Math.ceil((scroll + viewportCeil) / rowHeight), rowCount)
  const viewEnd = circuit.roundAffine([[scroll, 1], [viewportCeil, 1]], rowHeight - scrollGrid)
  const endVisible = emitMinimumExact(circuit, emitFloorDivide(circuit, viewEnd, rowHeight, maximumScrollTop + maximumViewportHeight + rowHeight), rowCount)
  circuit.assumeGrid(endVisible, 1)
  // The list draws a row in every slot: the rows in view, and in the slots left over
  // the rows above and below the view, half of them on each side. A browser scrolls
  // the list before the next frame runs, and until then the scrolled view shows the
  // rows that the last frame drew. E.g. a view of 19 rows has 22 rows drawn above it
  // and 23 below, so a scroll of up to 528 px between two frames still finds rows.
  // With 2 rows on each side, as the list drew until October 14, 2026, one step of a
  // mouse wheel, 100 px, showed a band without rows at the list's edge.
  // JS: spareSlots = Math.max(0, slotCount - (endVisible - firstVisible))
  const spareSlots = circuit.reglu([], 1, [[firstVisible, 1], [endVisible, -1]], slotCount)
  // The first row in view is at most the row count, since the scroll position is at
  // most the rows' total height, so endVisible - firstVisible is 0 or more.
  circuit.assumeRange(spareSlots, 0, slotCount)
  // JS: firstDrawn = Math.max(0, firstVisible - Math.floor(spareSlots / 2))
  const firstDrawn = circuit.reglu([], 1, [[firstVisible, 1], [emitFloorShift(circuit, spareSlots, 1, slotCount), -1]], 0)

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

  // Keys move the selection while the list's window is focused and the list has rows. A release in the
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
      // JS: present = row < rowCount
      emitCompare(circuit, row, '<', rowCount),
      emitCompare(circuit, row, '===', nextSelected),
    )
  }
  // JS: slotOverflow = endVisible - firstVisible > slotCount
  const slotOverflow = emitCompare(circuit, circuit.roundAffine([[endVisible, 1], [firstVisible, -1]]), '>', circuit.constant(slotCount))

  table.next(cells.selected, nextSelected)
  table.next(cells.location, nextLocation)
  return {totalHeight, scroll, scrollTarget, scrollRequest, slotOverflow, selected: nextSelected, locations: nextLocation, slots}
}

// The list on its own, in a table that also holds the cells that a host otherwise
// provides: the list viewport's height, whether its window is focused, a release over
// the list with its y, and a release on each location.
/** @public */
export function createValueListCircuit() {
  const table = createSourceTable()
  const cells = table.declare({
    viewportHeight: input([0, maximumViewportHeight], {initial: 266, grid: pixelGrid}),
    focused: inputBit(1),
    listClick: {active: event({grid: 1}), y: input([-49_152, 49_152], {grid: pixelGrid})},
    locationClicks: list(locationCount, () => event({grid: 1})),
    valueList: valueListCells,
  })
  table.atMostOne('value list keys', valueListKeys(cells.valueList))
  table.atMostOne('location clicks', cells.locationClicks)
  const circuit = table.createCircuit()
  const valueList = buildValueList(circuit, table, cells.valueList, {
    viewportHeight: cells.viewportHeight,
    focused: cells.focused,
    listClick: cells.listClick,
    locationClicks: cells.locationClicks,
  })
  const {nextSource, initialSource, validate} = table.finish()
  return {circuit, cells, output: valueList, nextSource, initialSource, validate}
}

// What the host shows in the list: a title per text column for the header, each
// row's text, and each row's current value. A row has a name, a kind, a layer and
// a number of stored weights, which never change, and a location leaves a column
// out with an empty title. The value column comes last.
const textColumnNames = ['name', 'kind', 'layer', 'weights'] as const
const kindColumn = textColumnNames.indexOf('kind')
type ColumnTexts = readonly [name: string, kind: string, layer: string, weights: string]
export type ValueListLocation = {
  // The sidebar item's text, e.g. 'Operations', which the item shows beside the row
  // count. The list's class name ends with it in lower case, e.g.
  // monitor-list-operations, so the stylesheet can size the location's columns.
  label: string
  // What a row is, e.g. 'operations', and a sentence for a visitor who doesn't know
  // the program's words. The sidebar shows the sentence under its items while the
  // list shows this location, and a pointer that rests on the item reads both, e.g.
  // '4,254 operations. What the program computes: each number from earlier ones.'
  rowNoun: string
  description: string
  titles: ColumnTexts
  rowCount: number
  text: (row: number) => ColumnTexts
  // A class for the row's kind cell, e.g. 'kind-reglu', which the stylesheet draws a
  // color swatch from. A location without one gives its kind cells no such class.
  kindClass?: (row: number) => string
  // The location's rows counted by kind, which the sidebar lists above the sentence,
  // e.g. 2,527 ReGLU among Operations' rows: each kind's name, the class of its
  // swatch, and what a pointer that rests on the entry reads. A kind that no row
  // has is left out. A location without kinds to count leaves the list out.
  kinds?: readonly {name: string, className: string, count: number, title: string}[]
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

// A count as the sidebar shows it, e.g. '4,254'.
const formatCount = (count: number) => count.toLocaleString('en-US')

// The four kinds of live operation, each with the text that a row shows, the class
// that the row's kind cell gets, and what the kind computes, in words for a
// visitor: a weighted sum, a ReGLU, a boolean atom and an index read. A sum that
// the compiler lowered to a gather read is still a sum, so it is an affine
// operation here.
const operationKinds = [
  {name: 'affine', className: 'kind-affine', computes: 'a weighted sum of earlier values'},
  {name: 'ReGLU', className: 'kind-reglu', computes: 'a weighted sum multiplied by another one while that one is positive'},
  {name: 'boolean', className: 'kind-boolean', computes: 'a value between 0 and 1 rounded to 0 or 1'},
  {name: 'index read', className: 'kind-index', computes: 'a copy of the table entry at a computed position'},
] as const

// The rows of a compiled program's live operations, in the program's packed order,
// i.e. layer by layer: the operation's wire, its kind, its layer counted from 1,
// and its number of stored weights. A ReGLU's weights include its gate's. An index
// read's are the weights of its index, e.g. 1 for a read at one wire's value: the
// read copies the table entry at that position and stores no weight for the
// entries. A gather read stores no weights. The numbers are kept in typed arrays,
// and a row's text is formatted when a slot shows the row. `packedValues` is the
// array that the program's evaluator computes in, see createTensorProgramEvaluator.
export function describeOperations(program: TensorProgram, packedValues: Float32Array): ValueListLocation {
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
  // How many rows each kind has, e.g. 0 index reads in a program that reads no table.
  const kindCounts = operationKinds.map(() => 0)
  for (let row = 0; row < rowCount; row++) kindCounts[kinds[row]!]!++
  return {
    label: 'Operations',
    rowNoun: 'operations',
    description: 'What the program computes: each number from earlier ones.',
    titles: ['wire', 'kind', 'layer', 'weights'],
    rowCount,
    kinds: operationKinds
      .map((kind, index) => {
        const count = kindCounts[index]!
        const name = `${kind.name[0]!.toUpperCase()}${kind.name.slice(1)}`
        return {name: kind.name, className: kind.className, count, title: `${name}, ${kind.computes}: ${formatCount(count)} of the ${formatCount(rowCount)} operations.`}
      })
      .filter(kind => kind.count > 0),
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
export function describeState(cells: readonly {name: string, policy: string}[], packedValues: Float32Array): ValueListLocation {
  return {
    label: 'State',
    rowNoun: 'cells',
    description: 'What the program reads: its input, its constants and the state it keeps.',
    titles: ['cell', 'kind', '', ''],
    rowCount: cells.length,
    text: row => [cells[row]!.name.replaceAll(/\[(\d+)\]/g, '.$1'), cells[row]!.policy, '', ''],
    value: row => packedValues[row]!,
  }
}

// The rows of the outputs that a page draws from, by name, e.g. 'windows.0.translateX'.
// `values` is the machine's array of root values, indexed by wire.
export function describeOutputs(outputs: readonly {name: string, wire: Wire}[], values: Float32Array): ValueListLocation {
  return {
    label: 'Outputs',
    rowNoun: 'outputs',
    description: 'What the page draws from, e.g. a window\'s position.',
    // The first column's title is 'name' and not 'output': in a window at its minimum
    // width, the list leaves 42 px for that title, and 'OUTPUT' takes 52 px.
    titles: ['name', '', '', ''],
    rowCount: outputs.length,
    text: row => [outputs[row]!.name, '', '', ''],
    value: row => values[outputs[row]!.wire]!,
  }
}

// Creates the sidebar's items, the caption's parts, the header's cells and the
// slots' row nodes inside `root`, the Monitor window's content box, and returns a
// frame's DOM read, DOM writes and side effect. `locations` holds one entry per
// location of the program, in order.
export function createValueListRenderer(document: Document, root: HTMLElement, locations: readonly ValueListLocation[]) {
  invariant(locations.length === locationCount, 'one entry per location')
  const sidebar = root.querySelector<HTMLElement>('.monitor-sidebar')
  const list = root.querySelector<HTMLElement>('.monitor-list')
  const header = root.querySelector<HTMLElement>('.monitor-header')
  const scroller = root.querySelector<HTMLElement>('.monitor-scroller')
  const spacer = root.querySelector<HTMLElement>('.monitor-spacer')
  const overflow = root.querySelector<HTMLElement>('.monitor-overflow')
  const caption = root.querySelector<HTMLElement>('.monitor-caption')
  invariant(sidebar !== null, 'Monitor\'s sidebar is missing')
  invariant(list !== null, 'Monitor\'s list is missing')
  invariant(header !== null, 'Monitor\'s header is missing')
  invariant(scroller !== null, 'Monitor\'s scroller is missing')
  invariant(spacer !== null, 'Monitor\'s spacer is missing')
  invariant(overflow !== null, 'Monitor\'s overflow notice is missing')
  invariant(caption !== null, 'the caption of Monitor\'s sidebar is missing')
  // The program's layout numbers, which the stylesheet reads, e.g. for a row's height.
  root.style.setProperty('--monitor-sidebar-width', `${monitorLayout.sidebarWidth}px`)
  root.style.setProperty('--monitor-header-height', `${monitorLayout.headerHeight}px`)
  root.style.setProperty('--monitor-row-height', `${monitorLayout.rowHeight}px`)
  root.style.setProperty('--monitor-scrollbar-strip', `${monitorLayout.scrollbarStrip}px`)
  root.style.setProperty('--monitor-footer-height', `${monitorLayout.footerHeight}px`)
  // One cell per column, for the header or for a row. Returns the elements that hold
  // the columns' texts: the cells, except for a row's name, which is written into a
  // <bdi> inside its cell. The stylesheet cuts a long name at its start by giving the
  // cell a direction of right to left, and the <bdi> keeps the name itself left to
  // right, e.g. '…ls.0.centerXDisplacement'.
  const createCells = (parent: HTMLElement, kind: 'header' | 'row') => [...textColumnNames, 'value'].map(column => {
    const cell = document.createElement('span')
    cell.className = `monitor-cell monitor-cell-${column}`
    parent.appendChild(cell)
    return kind === 'row' && column === 'name' ? cell.appendChild(document.createElement('bdi')) : cell
  })
  overflow.textContent = `Only ${slotCount} rows are drawn at a time.`
  const createPart = (parent: HTMLElement, tagName: string, className: string, text = '') => {
    const part = parent.appendChild(document.createElement(tagName))
    part.className = className
    part.textContent = text
    return part
  }
  // The caption's parts, from the top: for each location that counts its rows by
  // kind, a list of the kinds, e.g. 'ReGLU' and '2,527', which is displayed while
  // the list shows that location, and the shown location's sentence, e.g. 'What the
  // program computes: each number from earlier ones.'
  const captionKinds = locations.map(location => {
    if (location.kinds === undefined || location.kinds.length === 0) return null
    const kinds = createPart(caption, 'ul', 'monitor-caption-kinds')
    for (const kind of location.kinds) {
      const entry = createPart(kinds, 'li', kind.className)
      entry.title = kind.title
      createPart(entry, 'span', 'monitor-kind-name', kind.name)
      createPart(entry, 'span', 'monitor-kind-count', formatCount(kind.count))
    }
    return kinds
  })
  const captionSentence = createPart(caption, 'p', 'monitor-caption-sentence')
  const domCache = {
    list, // mount lifetime
    scroller, // mount lifetime
    spacer, // mount lifetime
    overflow, // mount lifetime
    captionKinds, // mount lifetime. null for a location without kinds.
    captionSentence, // mount lifetime
    headerCells: createCells(header, 'header'), // mount lifetime
    // mount lifetime. Each item sits on the rectangle that the program hit-tests.
    locationNodes: locations.map((location, index) => {
      const node = createPart(sidebar, 'div', 'monitor-location')
      createPart(node, 'span', 'monitor-location-label', location.label)
      createPart(node, 'span', 'monitor-location-count', formatCount(location.rowCount))
      node.style.left = `${monitorLayout.locationInset}px`
      node.style.top = `${monitorLayout.locationTop + index * monitorLayout.locationHeight}px`
      node.style.width = `${monitorLayout.sidebarWidth - 2 * monitorLayout.locationInset}px`
      node.style.height = `${monitorLayout.locationHeight}px`
      // For a pointer that rests on the item.
      node.title = `${formatCount(location.rowCount)} ${location.rowNoun}. ${location.description}`
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
      node.className = 'monitor-row'
      spacer.appendChild(node)
      return {node, cells: createCells(node, 'row'), row: -1, kindClass: '', value: Number.NaN}
    }),
  }

  return {
    // A DOM read, for the top of a frame. The machine floors and clamps the position.
    readScrollTop() {
      return domCache.scroller.scrollTop
    },
    // A frame's DOM writes.
    render(values: Float32Array, output: ValueListOutputs) {
      const locationIndex = output.locations.findIndex(wire => values[wire] === 1)
      const location = locations[locationIndex]
      invariant(location !== undefined, 'the list shows one location')
      domCache.locationNodes.forEach((node, index) => {
        node.style.setProperty('--selected', `${values[output.locations[index]!]}`)
      })
      if (domCache.location !== locationIndex) {
        // Another location: its column titles, its columns' sizes through the class
        // name, the sidebar's caption, and every slot's text, since a row index now
        // means another row.
        domCache.list.className = `monitor-list monitor-list-${location.label.toLowerCase()}`
        domCache.headerCells.forEach((cell, column) => {
          cell.textContent = location.titles[column] ?? 'value'
        })
        domCache.captionKinds.forEach((kinds, index) => {
          if (kinds !== null) kinds.style.display = index === locationIndex ? 'grid' : 'none'
        })
        domCache.captionSentence.textContent = location.description
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
            slot.cells[kindColumn]!.className = kindClass === '' ? 'monitor-cell monitor-cell-kind' : `monitor-cell monitor-cell-kind ${kindClass}`
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
    // `position`. The browser may round or clamp the position, and the next frame's
    // readScrollTop returns what the browser kept.
    scrollTo(position: number) {
      domCache.scroller.scrollTop = position
    },
  }
}

export function validateValueListOutputWires(output: ValueListOutputs, wireCount: number) {
  for (const wire of [output.totalHeight, output.scroll, output.scrollTarget, output.scrollRequest, output.slotOverflow, output.selected]) {
    assertWire(wire, wireCount)
  }
  validateWireView(output.locations, locationCount, wireCount)
  validateWireView(output.slots, slotCount * slotField.size, wireCount)
}

// The machine checks that every root value is finite before calling this.
export function validateValueListOutput(values: Float32Array, output: ValueListOutputs) {
  const isBit = (value: number | undefined) => value === 0 || value === 1
  const totalHeight = values[output.totalHeight]!
  invariant(totalHeight >= 0 && Number.isInteger(totalHeight / rowHeight), `the list's total height must be a whole number of rows, got ${totalHeight}`)
  for (const wire of [output.scroll, output.scrollTarget]) {
    invariant(values[wire]! >= 0 && values[wire]! <= maximumScrollTop, `a scroll position of the list must be within 0..${maximumScrollTop}, got ${values[wire]}`)
  }
  invariant(isBit(values[output.scrollRequest]), `the list's scroll request must equal zero or one, got ${values[output.scrollRequest]}`)
  invariant(isBit(values[output.slotOverflow]), `the list's slot overflow must equal zero or one, got ${values[output.slotOverflow]}`)
  const selected = values[output.selected]!
  invariant(Number.isInteger(selected) && selected >= -1, `the list's selected row must be a row or -1, got ${selected}`)
  let locationMass = 0
  for (const wire of output.locations) {
    const bit = values[wire]
    invariant(bit === 0 || bit === 1, `a location bit of the list must equal zero or one, got ${bit}`)
    locationMass += bit
  }
  invariant(locationMass === 1, `the list must show exactly one location, got ${locationMass}`)
  for (let slot = 0; slot < slotCount; slot++) {
    const outputStart = slot * slotField.size
    const row = values[output.slots[outputStart + slotField.row]!]!
    invariant(Number.isInteger(row) && row >= 0 && row % slotCount === slot, `slot ${slot} of the list must show a row whose index % ${slotCount} is ${slot}, got ${row}`)
    invariant(values[output.slots[outputStart + slotField.top]!] === row * rowHeight, `slot ${slot} of the list must be at its row's top`)
    invariant(isBit(values[output.slots[outputStart + slotField.present]!]), `slot ${slot} of the list: present must equal zero or one`)
    invariant(isBit(values[output.slots[outputStart + slotField.selected]!]), `slot ${slot} of the list: selected must equal zero or one`)
  }
}
