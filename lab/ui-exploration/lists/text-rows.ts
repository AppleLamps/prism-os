// A virtualized list of text rows whose heights come from pretext at the container's runtime width, as one program.
//
// JavaScript prepares each row's text once and writes the row's width breakpoints into cells (text-rows-prepare.ts).
// Before each evaluation it writes the container width, the viewport height, the scroller's scrollTop and the row
// count. The program computes every row's height at that width, stacks the rows, moves the view so that the row at the
// top of the view keeps its position on screen when rows above it change height, e.g. after a resize or an edit, and
// fills a fixed number of DOM slots. The row at the top of the view is found in the last evaluation's layout, which the
// program keeps as every row's bottom in state cells, at the scroll position the DOM reports now, so a scroll that lands
// in the same evaluation as a resize also keeps the row the user scrolled to in place. Changing a row's text rewrites that row's cells, and appending a row writes the
// next row's cells and a larger row count, so the compiled program never changes.
//
// Every capacity has a named fallback:
// - `full`: the row count reached `capacity`, and the host refuses more rows.
// - `slotOverflow`: rows in view past the last DOM slot, which get no DOM node.
// - each slot's `clamped`: the container is narrower than the row's minimum width, so the row is laid out at that
//   width, because its text loses more lines than its breakpoint cells hold as the container widens.
// - The host clamps the container width into 375..1200 and the viewport height into 0..4096, and text-rows-prepare.ts
//   refuses a text taller than 256 px at 1200 px.
import {type Wire, emitCompare, emitMaximumExact, emitMinimumExact, emitSelect, invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {type WireValues, createEvaluator, createSourceTable, input, list, state} from '../../../src/runtime/cells.ts'
import {emitFloorOnGrid, emitPrefixSums} from './common.ts'
import {textRowLayout, unusedBreakpoint, type TextRowTable} from './text-rows-prepare.ts'

export type TextRowsOptions = {
  // How many rows the table holds.
  capacity: number
  // How many DOM slots the program fills, a power of two.
  slotCount: number
  // How many breakpoints each row holds, one less than a power of two.
  breakpointCapacity: number
}

export const defaultTextRowsOptions: TextRowsOptions = {capacity: 10_000, slotCount: 64, breakpointCapacity: 7}
export const maximumViewportHeight = 4096

export function textRowsCells({capacity, breakpointCapacity}: TextRowsOptions) {
  const {minimumContainerWidth, maximumContainerWidth, maximumRowHeight} = textRowLayout
  const maximumTotalHeight = capacity * maximumRowHeight
  return {
    containerWidth: input([minimumContainerWidth, maximumContainerWidth], {initial: 800, grid: 1}),
    viewportHeight: input([0, maximumViewportHeight], {initial: 600, grid: 1}),
    // The scroller's scrollTop as the DOM holds it before this evaluation, floored onto quarter pixels.
    scrollTop: input([0, maximumTotalHeight], {grid: 1 / 4}),
    rowCount: input([0, capacity], {grid: 1}),
    // The rows' tables, one column per field. Rows at or past rowCount hold height 0: base height 0 and unused breakpoints.
    baseHeights: list(capacity, () => input([0, maximumRowHeight], {grid: 1})),
    minimumWidths: list(capacity, () => input([minimumContainerWidth, maximumContainerWidth], {initial: minimumContainerWidth, grid: 1})),
    breakpoints: list(capacity * breakpointCapacity, () => input([minimumContainerWidth, unusedBreakpoint], {initial: unusedBreakpoint, grid: 1})),
    // Every row's bottom after the last evaluation, i.e. the layout the DOM shows before this evaluation. The last one is
    // the total height, which the DOM's spacer still has.
    previousBottoms: list(capacity, () => state([0, maximumTotalHeight], {grid: 1})),
  }
}

// The most rows buildTextRows accepts. scrollTop lies on quarter pixels, and FP32 holds every quarter pixel only up to
// 2^22 px, e.g. above it 4,194,304.25 becomes 4,194,304, which moves a scroll position that sits a quarter pixel above
// a row's top into that row. 16,384 rows × 256 px is exactly 2^22 px.
export const maximumTextRowsCapacity = 2 ** 22 / textRowLayout.maximumRowHeight

export function buildTextRows(options: TextRowsOptions = defaultTextRowsOptions) {
  const {capacity, slotCount, breakpointCapacity} = options
  invariant(Number.isInteger(Math.log2(breakpointCapacity + 1)) && breakpointCapacity >= 1, `breakpointCapacity must be one less than a power of two, e.g. 7, got ${breakpointCapacity}`)
  invariant(Number.isInteger(Math.log2(slotCount)), `slotCount must be a power of two, got ${slotCount}`)
  invariant(Number.isInteger(capacity) && capacity >= 1 && capacity <= maximumTextRowsCapacity, `capacity must be within 1..${maximumTextRowsCapacity.toLocaleString('en-US')}, so that scrollTop's quarter pixels stay exact in FP32, got ${capacity}`)
  const {lineHeight, maximumRowHeight} = textRowLayout
  const table = createSourceTable()
  const cells = table.declare(textRowsCells(options))
  const circuit = table.createCircuit()
  const zero = circuit.constant(0)
  // An index read copies a cell or a wire without rounding, but gets no inferred grid, so declare the grid that every
  // candidate lies on, e.g. whole pixels for breakpoints and row tops.
  const onWholePixels = (wire: Wire) => {
    circuit.assumeGrid(wire, 1)
    return wire
  }
  // JS: left && right, for exact bits, as relu(left + right - 1).
  const and = (left: Wire, right: Wire) => circuit.reglu([], 1, [[left, 1], [right, 1]], -1)

  // Every row's height at this container width.
  // JS: height = baseHeight - lineHeight × breakpoints.filter(breakpoint => breakpoint <= containerWidth).length
  // A row's breakpoints are sorted, so the count is a binary search of log2(breakpointCapacity + 1) index reads, and
  // the first read is at a constant position, which the builder resolves while building.
  const searchLevels = Math.log2(breakpointCapacity + 1)
  const rowHeights = cells.baseHeights.map((baseHeight, row) => {
    const countTerms: [Wire, number][] = []
    for (let level = searchLevels - 1; level >= 0; level--) {
      const step = 2 ** level
      // JS: if (breakpoints[row × breakpointCapacity + count + step - 1] <= containerWidth) count += step
      const breakpoint = onWholePixels(circuit.indexReadAffine([...countTerms], row * breakpointCapacity + step - 1, cells.breakpoints, 'clamp', 'clamp'))
      countTerms.push([emitCompare(circuit, breakpoint, '<=', cells.containerWidth), step])
    }
    const height = circuit.roundAffine([[baseHeight, 1], ...countTerms.map(([bit, step]) => [bit, -lineHeight * step] as const)])
    circuit.assumeRange(height, 0, maximumRowHeight)
    return height
  })

  // JS: bottoms[row] = bottoms[row - 1] + heights[row]. Heights are whole pixels and totals stay below 2^24, so any
  // grouping adds exactly, and a Brent-Kung network (patterns.md, "Running totals") keeps about 2 log2(capacity) layers.
  const bottoms = emitPrefixSums(circuit, rowHeights, 'brentKung')
  const totalHeight = bottoms[capacity - 1]!
  // tops[row] for row in 0..capacity, where tops[capacity] is the total height.
  const tops = [zero, ...bottoms]

  // JS: bottoms.filter(bottom => bottom <= position).length, for bottoms that never decrease, as a binary search of
  // ceil(log2(capacity + 1)) index reads. A read past the table clamps to the last bottom, the total height, so the
  // count can pass `capacity` only when position is at or past the total height.
  const rowSearchLevels = Math.ceil(Math.log2(capacity + 1))
  const countBottomsAtOrAbove = (sortedBottoms: readonly Wire[], position: Wire) => {
    const terms: [Wire, number][] = []
    for (let level = rowSearchLevels - 1; level >= 0; level--) {
      const step = 2 ** level
      const bottom = onWholePixels(circuit.indexReadAffine([...terms], step - 1, sortedBottoms, 'clamp', 'clamp'))
      terms.push([emitCompare(circuit, bottom, '<=', position), step])
    }
    return circuit.roundAffine(terms)
  }

  // The scroll position after this evaluation's changes.
  const previousTotalHeight = cells.previousBottoms[capacity - 1]!
  // JS: atBottom = scrollTop + viewportHeight >= previousTotalHeight, i.e. the view showed the end of the rows
  const atBottom = emitCompare(circuit, circuit.affine([[cells.scrollTop, 1], [cells.viewportHeight, 1]]), '>=', previousTotalHeight)
  // JS: maximumScroll = Math.max(0, totalHeight - viewportHeight)
  const maximumScroll = emitMaximumExact(circuit, circuit.affine([[totalHeight, 1], [cells.viewportHeight, -1]]), zero)
  // JS: anchorRow = previousBottoms.findIndex(bottom => bottom > scrollTop), the row at the top of the view as the DOM
  // shows it: the last evaluation's layout at the scroll position the DOM reports now, which includes any scroll since
  // the last evaluation. When no previous bottom is below scrollTop, atBottom holds and anchorRow isn't used, so the
  // reads below only need to stay within the table.
  const anchorRow = countBottomsAtOrAbove(cells.previousBottoms, cells.scrollTop)
  const anchorTop = onWholePixels(circuit.indexReadAffine([[anchorRow, 1]], 0, [zero, ...cells.previousBottoms], 'clamp', 'clamp'))
  const anchorRowTop = onWholePixels(circuit.indexReadAffine([[anchorRow, 1]], 0, tops, 'clamp', 'clamp'))
  // JS: anchored = scrollTop + tops[anchorRow] - anchorTop, which moves the view by as much as the row at its top moved
  const anchored = circuit.affine([[cells.scrollTop, 1], [anchorRowTop, 1], [anchorTop, -1]])
  // JS: scrollTop = atBottom ? maximumScroll : Math.min(anchored, maximumScroll). anchored is never negative, since the
  // search puts the anchor row's previous top at or above scrollTop, so Math.max(anchored, 0) would change nothing.
  const scrollTop = emitSelect(circuit, atBottom, emitMinimumExact(circuit, anchored, maximumScroll), maximumScroll)
  circuit.assumeRange(scrollTop, 0, capacity * maximumRowHeight)
  circuit.assumeGrid(scrollTop, 1 / 4)

  // JS: firstRow = the first row whose bottom is below scrollTop, or rowCount. Rows past rowCount have the total height
  // as their bottom, so Math.min brings the count back to rowCount when scrollTop reaches the total height.
  const firstRow = onWholePixels(emitMinimumExact(circuit, countBottomsAtOrAbove(bottoms, scrollTop), cells.rowCount))

  // DOM slots. JS: offset = firstRow % slotCount, with the floor of firstRow / slotCount from rounding.
  const block = emitFloorOnGrid(circuit, firstRow, 1 / slotCount, Math.log2(slotCount))
  const offset = circuit.roundAffine([[firstRow, 1], [block, -slotCount]])
  circuit.assumeRange(offset, 0, slotCount - 1)
  circuit.assumeGrid(offset, 1)
  const viewBottom = circuit.affine([[scrollTop, 1], [cells.viewportHeight, 1]])
  const slots = Array.from({length: slotCount}, (_, slot) => {
    // JS: row = the row in firstRow..firstRow + slotCount - 1 whose index % slotCount === slot, so a row keeps its DOM
    // node while it stays in view.
    const wraps = emitCompare(circuit, offset, '>', circuit.constant(slot))
    const row = circuit.roundAffine([[firstRow, 1], [offset, -1], [wraps, slotCount]], slot)
    circuit.assumeRange(row, 0, capacity + slotCount - 1)
    const top = onWholePixels(circuit.indexRead(row, tops))
    const height = onWholePixels(circuit.indexRead(row, rowHeights))
    const minimumWidth = onWholePixels(circuit.indexRead(row, cells.minimumWidths))
    return {
      row,
      top,
      height,
      // JS: present = row < rowCount && top < scrollTop + viewportHeight. Every row from firstRow on ends below scrollTop.
      present: and(emitCompare(circuit, row, '<', cells.rowCount), emitCompare(circuit, top, '<', viewBottom)),
      // JS: layoutWidth = Math.max(containerWidth, minimumWidth)
      layoutWidth: emitMaximumExact(circuit, cells.containerWidth, minimumWidth),
      // JS: clamped = containerWidth < minimumWidth
      clamped: emitCompare(circuit, cells.containerWidth, '<', minimumWidth),
    }
  })
  // JS: slotOverflow = rowCount > firstRow + slotCount && tops[firstRow + slotCount] < scrollTop + viewportHeight
  const rowAfterSlots = circuit.affine([[firstRow, 1]], slotCount)
  const slotOverflow = and(
    emitCompare(circuit, rowAfterSlots, '<', cells.rowCount),
    emitCompare(circuit, onWholePixels(circuit.indexRead(rowAfterSlots, tops)), '<', viewBottom),
  )
  // JS: full = rowCount >= capacity
  const full = emitCompare(circuit, cells.rowCount, '>=', circuit.constant(capacity))

  table.next(cells.previousBottoms, bottoms)
  const output = {scrollTop, firstRow, totalHeight, full, slotOverflow, slots}
  return {cells, options, rowHeights, output, ...table.finish()}
}

export type TextRowsProgram = ReturnType<typeof buildTextRows>
export type TextRowsOutput = WireValues<TextRowsProgram['output']>
export type TextRowsInput = {containerWidth: number, viewportHeight: number, scrollTop: number, rowCount: number}

// Every wire the host reads: the next values of the state cells, i.e. every row's bottom, then the outputs, in the
// output's field order.
export function textRowsRoots(program: TextRowsProgram): Wire[] {
  const {cells, nextSource, output} = program
  return [
    ...cells.previousBottoms.map(cell => nextSource[cell]!),
    output.scrollTop, output.firstRow, output.totalHeight, output.full, output.slotOverflow,
    ...output.slots.flatMap(slot => [slot.row, slot.top, slot.height, slot.present, slot.layoutWidth, slot.clamped]),
  ]
}

// The host's side of the contract: a whole-pixel container width within 375..1200, where a narrower or wider container
// lays rows out at the nearest end, a whole-pixel viewport height within 0..4096, and scrollTop floored onto quarter
// pixels, e.g. 1234.6 becomes 1234.5.
export function quantizeTextRowsInput(raw: TextRowsInput, capacity: number): TextRowsInput {
  const {minimumContainerWidth, maximumContainerWidth, maximumRowHeight} = textRowLayout
  return {
    containerWidth: Math.min(maximumContainerWidth, Math.max(minimumContainerWidth, Math.round(raw.containerWidth))),
    viewportHeight: Math.min(maximumViewportHeight, Math.max(0, Math.round(raw.viewportHeight))),
    scrollTop: Math.min(capacity * maximumRowHeight, Math.max(0, Math.floor(raw.scrollTop * 4) / 4)),
    rowCount: raw.rowCount,
  }
}

export function createTextRowsMachine(program: TextRowsProgram) {
  const {cells, options} = program
  const evaluate = createEvaluator(program)
  const source = new Float32Array(program.initialSource)
  // The state cells, every row's bottom, were declared one after another, so their next values copy back with one
  // Float32Array.set, about 0.4 µs at 10,000 rows, where a loop over their positions took about 140 µs.
  const firstBottomCell = cells.previousBottoms[0]!
  invariant(cells.previousBottoms.every((cell, row) => cell === firstBottomCell + row), 'the previousBottoms cells must be contiguous in the source table')
  return {
    program,
    source,
    // Writes one row's table into its cells, e.g. for an appended row or an edited text. The compiled program stays
    // the same. Every row's height adds into the total height, including rows at or past the row count, which must keep
    // the empty table they start with, base height 0 and unused breakpoints. So append by writing the row at the row
    // count and passing the larger row count to the next step.
    writeRow(row: number, rowTable: TextRowTable) {
      const {minimumContainerWidth, maximumContainerWidth, lineHeight, maximumRowHeight} = textRowLayout
      const {baseHeight, minimumWidth, breakpoints} = rowTable
      invariant(Number.isInteger(row) && row >= 0 && row < options.capacity, `row ${row} is outside the table of ${options.capacity} rows`)
      invariant(breakpoints.length === options.breakpointCapacity, `a row table needs ${options.breakpointCapacity} breakpoints, got ${breakpoints.length}`)
      invariant(Number.isInteger(minimumWidth) && minimumWidth >= minimumContainerWidth && minimumWidth <= maximumContainerWidth, `row ${row}'s minimum width must be a whole pixel within ${minimumContainerWidth}..${maximumContainerWidth}, got ${minimumWidth}`)
      // e.g. [512, 512, 900, 1201, 1201, 1201, 1201] for a row with minimum width 375 px.
      breakpoints.forEach((breakpoint, index) => {
        const used = Number.isInteger(breakpoint) && breakpoint > minimumWidth && breakpoint <= maximumContainerWidth
        invariant((used || breakpoint === unusedBreakpoint) && (index === 0 || breakpoint >= breakpoints[index - 1]!), `row ${row}'s breakpoints must never decrease, and each one must be a whole pixel above the minimum width ${minimumWidth} px and at most ${maximumContainerWidth} px, or ${unusedBreakpoint}, got [${breakpoints.join(', ')}]`)
      })
      const lostLines = breakpoints.filter(breakpoint => breakpoint !== unusedBreakpoint).length
      invariant(Number.isInteger(baseHeight) && baseHeight <= maximumRowHeight && baseHeight - lostLines * lineHeight >= lineHeight, `row ${row}'s base height must be a whole pixel of at most ${maximumRowHeight} px that leaves at least one line after its breakpoints, got ${baseHeight} px with ${lostLines} breakpoints`)
      source[cells.baseHeights[row]!] = baseHeight
      source[cells.minimumWidths[row]!] = minimumWidth
      breakpoints.forEach((breakpoint, index) => {
        source[cells.breakpoints[row * options.breakpointCapacity + index]!] = breakpoint
      })
    },
    step(frameInput: TextRowsInput): TextRowsOutput {
      source[cells.containerWidth] = frameInput.containerWidth
      source[cells.viewportHeight] = frameInput.viewportHeight
      source[cells.scrollTop] = frameInput.scrollTop
      source[cells.rowCount] = frameInput.rowCount
      const result = evaluate(source)
      // Only the state cells change, every row's bottom: an input cell's next value is the cell itself.
      source.set(result.nextValues.subarray(firstBottomCell, firstBottomCell + options.capacity), firstBottomCell)
      return result.output
    },
  }
}

// The slots that show a row, in slot order, as plain numbers.
export function drawnSlots(output: TextRowsOutput) {
  return output.slots.flatMap((slot, index) => slot.present === 1
    ? [{slot: index, row: slot.row, top: slot.top, height: slot.height, layoutWidth: slot.layoutWidth, clamped: slot.clamped}]
    : [])
}
