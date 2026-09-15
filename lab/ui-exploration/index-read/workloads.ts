// The brief's workloads, each built two ways over the same source layout: with
// the relu one-hot construction (which report.ts compiles dense, with the shared
// gather lowering, and with the index one-hot recognition), and with the index
// read instruction. Each workload also has a plain JS reference that never
// touches the circuit.
import {
  emitAtLeastZeroRounding,
  emitClampedOneHot,
  emitFloorDivide,
  emitIntegerAtLeast,
  emitIntegerOneHot,
  emitMaskedRead,
  emitMaximumTournament,
  emitReluForm,
  SourceLayout,
} from './constructions.ts'
import {type Circuit, emitMaximum, type OutOfRange, type Wire} from './numeric-ui-core.ts'

export type Construction = 'one-hot' | 'instruction'

const f = Math.fround

// ---------------------------------------------------------------- values[index]

export function buildTableRead(count: number, construction: Construction) {
  const layout = new SourceLayout()
  const index = layout.cell(0, 0, count - 1)
  const values = layout.cells(count, position => position, -1e6, 1e6)
  const circuit = layout.createCircuit()
  const read = construction === 'instruction'
    ? circuit.indexRead(index, values)
    : circuit.affine(emitClampedOneHot(circuit, index, count).map((bit, position) =>
        [circuit.multiply(bit, values[position]!), 1] as const))
  return {circuit, layout, roots: [read], index, values, read}
}

// ---------------------------------------------------------------- line recovery

// Prepared data and pretext's own results, as written by the fixture script.
export type PretextSample = {
  wordCount: number
  segmentCount: number
  widths: number[]
  kinds: string[]
  window: number
  lineSlots: number
  minimumWidth: number
  maximumWidth: number
  stats: [width: number, lineCount: number, maxLineWidth: number][]
  lines: {width: number, starts: number[], widths: number[]}[]
}

export type PretextFixture = {lineFitEpsilon: number, samples: PretextSample[]}

// Tables for pretext's fast path (text, space, zero-width break; no letter
// spacing), as in phase 1's prefix-sum walker:
// - fitThreshold[i]: the prefix width a line must stay within to append segment
//   i. Text counts its own width; a space or zero-width break hangs, so counts
//   nothing.
// - skip[i]: how many consumable segments a line starting at i skips.
// - paintEnd[i]: the painted prefix width of a line that ends before i, trailing
//   spaces excluded.
export function prefixTables(sample: PretextSample) {
  const {widths, kinds, window} = sample
  const segmentCount = widths.length
  const prefix = [0]
  for (const width of widths) prefix.push(prefix[prefix.length - 1]! + width)
  const padded = segmentCount + window + 2
  const huge = 1_000_000
  const fitThreshold: number[] = []
  const skip: number[] = []
  const paintEnd: number[] = []
  const consumable = (index: number) => kinds[index] === 'space' || kinds[index] === 'zero-width-break'
  for (let index = 0; index < padded; index++) {
    if (index >= segmentCount) {
      fitThreshold.push(huge)
      skip.push(0)
    } else {
      fitThreshold.push(consumable(index) ? prefix[index]! : prefix[index + 1]!)
      let next = index
      while (next < segmentCount && consumable(next)) next++
      skip.push(next - index)
    }
    let contentEnd = Math.min(index, segmentCount)
    while (contentEnd > 0 && consumable(contentEnd - 1)) contentEnd--
    paintEnd.push(prefix[contentEnd]!)
  }
  return {segmentCount, prefix, fitThreshold, skip, paintEnd}
}

function allocatePrefixCells(sample: PretextSample) {
  const tables = prefixTables(sample)
  const layout = new SourceLayout()
  const maxWidth = layout.cell(sample.minimumWidth, 0, 100_000)
  // A runtime cell rather than a constant: a one-hot built from a constant folds
  // into duplicate wires.
  const startCursor = layout.cell(0, 0, tables.segmentCount)
  const prefix = tables.prefix.map(value => layout.cell(value, 0, 1_000_000))
  const fitThreshold = tables.fitThreshold.map(value => layout.cell(value, 0, 1_000_000))
  const skip = tables.skip.map(value => layout.cell(value, 0, 16))
  const paintEnd = tables.paintEnd.map(value => layout.cell(value, 0, 1_000_000))
  return {layout, maxWidth, startCursor, prefix, fitThreshold, skip, paintEnd, tables}
}

// For every start s: the next line start and the painted width, by counting how
// many segments from s still fit. The fit bits are monotone along the offset, so
// the first failure is a difference of neighbors. Shared by every variant.
function buildNextTable(
  circuit: Circuit,
  cells: ReturnType<typeof allocatePrefixCells>,
  window: number,
  lineFitEpsilon: number,
) {
  const {segmentCount} = cells.tables
  const nextStart: Wire[] = []
  const lineWidth: Wire[] = []
  const windowOverflow: Wire[] = []
  for (let start = 0; start < segmentCount; start++) {
    const fits: Wire[] = []
    for (let offset = 1; offset <= window; offset++) {
      fits.push(emitAtLeastZeroRounding(
        circuit,
        [[cells.maxWidth, 1], [cells.fitThreshold[start + offset]!, -1], [cells.prefix[start]!, 1]],
        lineFitEpsilon,
      ))
    }
    const nextTerms: [Wire, number][] = []
    const widthTerms: [Wire, number][] = [[cells.prefix[start]!, -1]]
    for (let offset = 1; offset <= window; offset++) {
      const firstFailure = offset === 1
        ? circuit.roundAffine([[fits[0]!, -1]], 1)
        : circuit.roundAffine([[fits[offset - 2]!, 1], [fits[offset - 1]!, -1]])
      circuit.assumeRange(firstFailure, 0, 1)
      nextTerms.push([firstFailure, start + offset])
      nextTerms.push([circuit.multiply(cells.skip[start + offset]!, firstFailure), 1])
      widthTerms.push([circuit.multiply(cells.paintEnd[start + offset]!, firstFailure), 1])
    }
    const next = circuit.roundAffine(nextTerms)
    circuit.assumeRange(next, start + 1, segmentCount)
    nextStart.push(next)
    const width = circuit.roundAffine(widthTerms)
    circuit.assumeRange(width, 0, 100_000)
    lineWidth.push(width)
    windowOverflow.push(fits[window - 1]!)
  }
  return {nextStart, lineWidth, windowOverflow}
}

export type LineRecoveryFormulation = 'sequential' | 'jumping' | 'table-only'

// Line starts recovered from the next-start table.
// - sequential: one line at a time, reading nextStart and lineWidth at the
//   current start. Outputs lineCount, maxLineWidth, overflow, then each line
//   slot's start and width.
// - jumping: jump[m + 1][s] = jump[m][jump[m][s]] over windows, then binary
//   lifting from the start cursor. Outputs lineCount, maxLineWidth.
// - table-only: just the next-start table, to separate its cost.
export function buildLineRecovery(
  sample: PretextSample,
  lineFitEpsilon: number,
  construction: Construction,
  formulation: LineRecoveryFormulation,
) {
  const cells = allocatePrefixCells(sample)
  const circuit = cells.layout.createCircuit()
  const {segmentCount, skip} = cells.tables
  const {nextStart, lineWidth, windowOverflow} = buildNextTable(circuit, cells, sample.window, lineFitEpsilon)
  const anyWindowOverflow = circuit.roundAffine(windowOverflow.map(bit => [bit, 1] as const))
  const roots: Wire[] = []
  if (formulation === 'table-only') {
    roots.push(...nextStart, ...lineWidth, anyWindowOverflow)
  } else if (formulation === 'sequential') {
    let start: Wire = cells.startCursor
    const presentBits: Wire[] = []
    const widths: Wire[] = []
    const lineRoots: Wire[] = []
    for (let line = 0; line < sample.lineSlots; line++) {
      // [start <= segmentCount - 1], an exact integer bit either way.
      const present = emitIntegerAtLeast(circuit, [[start, -1]], segmentCount - 1, 0)
      let width: Wire
      let next: Wire
      if (construction === 'one-hot') {
        const members = emitIntegerOneHot(circuit, [[start, 1]], 0, segmentCount, true)
        width = emitMaskedRead(circuit, members, lineWidth)
        next = emitMaskedRead(circuit, members, nextStart)
      } else {
        width = circuit.indexRead(start, lineWidth, {outOfRange: 'zero'})
        next = circuit.indexRead(start, nextStart, {outOfRange: 'zero'})
      }
      // An exhausted line reads zeros; keep its start at segmentCount.
      const nextOrEnd = circuit.roundAffine([[next, 1], [present, -segmentCount]], segmentCount)
      circuit.assumeRange(nextOrEnd, 0, segmentCount)
      presentBits.push(present)
      widths.push(width)
      lineRoots.push(start, width)
      start = nextOrEnd
    }
    const lineCount = circuit.roundAffine(presentBits.map(bit => [bit, 1] as const))
    const maxLineWidth = emitMaximumTournament(widths, (left, right) => emitMaximum(circuit, left, right))
    roots.push(lineCount, maxLineWidth, anyWindowOverflow, ...lineRoots)
  } else {
    const end = circuit.affine([], segmentCount)
    const zero = circuit.affine([], 0)
    const maximumSkip = Math.max(...skip)
    let jump: Wire[] = [...nextStart, end]
    let widest: Wire[] = [...lineWidth, zero]
    const jumps = [jump]
    const widests = [widest]
    const levels = Math.max(1, Math.ceil(Math.log2(sample.lineSlots)))
    for (let level = 1; level < levels; level++) {
      const reach = (sample.window + maximumSkip) * 2 ** (level - 1)
      const nextJump: Wire[] = []
      const nextWidest: Wire[] = []
      for (let start = 0; start < segmentCount; start++) {
        // jump[start] lies in start..start + span, so the read only spans that window.
        const span = Math.min(segmentCount - start, reach)
        const windowJump = jump.slice(start, start + span + 1)
        const windowWidest = widest.slice(start, start + span + 1)
        let composed: Wire
        let composedWidest: Wire
        if (construction === 'one-hot') {
          const members = emitIntegerOneHot(circuit, [[jump[start]!, 1]], -start, span + 1, false)
          composed = emitMaskedRead(circuit, members, windowJump)
          composedWidest = emitMaskedRead(circuit, members, windowWidest)
        } else {
          // Leave out the absorbing end entry so the table stays evenly spaced
          // in packed storage. A jump to the end clamps to the last segment's
          // entry, which already holds segmentCount; the widest line there is 0.
          const entries = Math.min(span + 1, segmentCount - start)
          composed = circuit.indexReadAffine([[jump[start]!, 1]], -start, jump.slice(start, start + entries), 'clamp', 'clamp')
          composedWidest = circuit.indexReadAffine([[jump[start]!, 1]], -start, widest.slice(start, start + entries), 'clamp', 'zero')
        }
        circuit.assumeRange(composed, start, segmentCount)
        nextJump.push(composed)
        nextWidest.push(emitMaximum(circuit, widest[start]!, composedWidest))
      }
      jump = [...nextJump, end]
      widest = [...nextWidest, zero]
      jumps.push(jump)
      widests.push(widest)
    }
    let cursor: Wire = cells.startCursor
    const countTerms: [Wire, number][] = []
    let best: Wire = zero
    const readAt = (table: readonly Wire[], at: Wire, above: OutOfRange) => {
      if (construction === 'instruction') {
        return circuit.indexReadAffine([[at, 1]], 0, table.slice(0, segmentCount), 'clamp', above)
      }
      return emitMaskedRead(circuit, emitIntegerOneHot(circuit, [[at, 1]], 0, segmentCount + 1, false), table)
    }
    for (let level = levels - 1; level >= 0; level--) {
      const candidate = readAt(jumps[level]!, cursor, 'clamp')
      const candidateWidest = readAt(widests[level]!, cursor, 'zero')
      // take = [candidate <= segmentCount - 1]
      const upper = emitReluForm(circuit, [[candidate, -1]], segmentCount)
      const lower = emitReluForm(circuit, [[candidate, -1]], segmentCount - 1)
      const take = circuit.roundAffine([[upper, 1], [lower, -1]])
      circuit.assumeRange(take, 0, 1)
      countTerms.push([take, 2 ** level])
      best = emitMaximum(circuit, best, circuit.multiply(candidateWidest, take))
      cursor = circuit.select(take, cursor, candidate)
      circuit.assumeRange(cursor, 0, segmentCount)
    }
    best = emitMaximum(circuit, best, readAt(widests[0]!, cursor, 'zero'))
    const lineCount = circuit.roundAffine(countTerms, 1)
    roots.push(lineCount, best)
  }
  return {circuit, layout: cells.layout, roots, maxWidth: cells.maxWidth}
}

// ---------------------------------------------------------------- virtual list

export type VirtualListOptions = {
  rowCount: number
  fieldCount: number
  slotCount: number
  rowHeight: number
}

export function rowField(row: number, field: number) {
  return f(field === 0 ? row : field === 1 ? (row * 37) % 1000 + 0.5 : (row * 7919) % 360)
}

// A fixed-height list: firstRow = floor(scrollTop / rowHeight), then slotCount
// DOM slots each read fieldCount fields of row firstRow + k. Fields are stored
// column by column, so each field is one contiguous run of source cells. Rows
// past the end read zeros and report present = 0.
export function buildVirtualList(options: VirtualListOptions, construction: Construction) {
  const {rowCount, fieldCount, slotCount, rowHeight} = options
  const layout = new SourceLayout()
  const scrollTop = layout.cell(0, 0, (rowCount - 1) * rowHeight)
  const columns = Array.from({length: fieldCount}, (_, field) =>
    layout.cells(rowCount, row => rowField(row, field), -1e6, 1e6))
  // The one-hot reads slot k's field at position j from cell j + k, so rows
  // past the end need real zero cells: a constant candidate folds away and
  // leaves a partial sum that cannot lower.
  const padding = construction === 'one-hot'
    ? Array.from({length: fieldCount}, () => layout.cells(slotCount, () => 0, 0, 0))
    : []
  const circuit = layout.createCircuit()
  const firstRow = emitFloorDivide(circuit, scrollTop, rowHeight)
  circuit.assumeRange(firstRow, 0, rowCount - 1)
  const members = construction === 'one-hot'
    ? emitIntegerOneHot(circuit, [[firstRow, 1]], 0, rowCount, false)
    : []
  const roots: Wire[] = [firstRow]
  for (let slot = 0; slot < slotCount; slot++) {
    const present = emitIntegerAtLeast(circuit, [[firstRow, -1]], rowCount - 1 - slot, 0)
    const translateY = circuit.roundAffine([[firstRow, rowHeight], [scrollTop, -1]], slot * rowHeight)
    roots.push(present, translateY)
    for (let field = 0; field < fieldCount; field++) {
      if (construction === 'instruction') {
        roots.push(circuit.indexReadAffine([[firstRow, 1]], slot, columns[field]!, 'clamp', 'zero'))
      } else {
        const shifted = Array.from({length: rowCount}, (_, position) =>
          position + slot < rowCount ? columns[field]![position + slot]! : padding[field]![position + slot - rowCount]!)
        roots.push(emitMaskedRead(circuit, members, shifted))
      }
    }
  }
  return {circuit, layout, roots, scrollTop}
}

export function referenceVirtualList(options: VirtualListOptions, scrollTop: number): number[] {
  const {rowCount, fieldCount, slotCount, rowHeight} = options
  const firstRow = Math.floor(scrollTop / rowHeight)
  const outputs = [firstRow]
  for (let slot = 0; slot < slotCount; slot++) {
    const row = firstRow + slot
    outputs.push(row < rowCount ? 1 : 0, row * rowHeight - scrollTop)
    for (let field = 0; field < fieldCount; field++) outputs.push(row < rowCount ? rowField(row, field) : 0)
  }
  return outputs
}

export type VariableListFormulation = 'count' | 'binary-search'

export function rowHeightAt(row: number) {
  return 20 + (row * 2654435761 % 97) % 41
}

// A list with per-row heights: the table holds each row's top (prefix sums
// prepared in JS, rowCount + 1 cells). firstRow is the largest row whose top is
// at or above scrollTop, found either by counting [top_j <= scrollTop] over
// every row, or by a binary search of index reads. Slots then read their top and
// fields at firstRow + k.
export function buildVariableRowList(
  options: VirtualListOptions,
  construction: Construction,
  formulation: VariableListFormulation,
) {
  const {rowCount, fieldCount, slotCount} = options
  const tops = [0]
  for (let row = 0; row < rowCount; row++) tops.push(tops[row]! + rowHeightAt(row))
  const total = tops[rowCount]!
  const layout = new SourceLayout()
  const scrollTop = layout.cell(0, 0, total - 1)
  const topCells = layout.cells(rowCount + 1, row => tops[row]!, 0, total)
  const columns = Array.from({length: fieldCount}, (_, field) =>
    layout.cells(rowCount, row => rowField(row, field), -1e6, 1e6))
  const topPadding = construction === 'one-hot' ? layout.cells(slotCount, () => total, total, total) : []
  const padding = construction === 'one-hot'
    ? Array.from({length: fieldCount}, () => layout.cells(slotCount, () => 0, 0, 0))
    : []
  const circuit = layout.createCircuit()
  let firstRow: Wire
  if (formulation === 'count') {
    // Tops increase with the row, so the rows at or above scrollTop form a
    // prefix and their count is the answer.
    const terms: [Wire, number][] = []
    for (let row = 1; row < rowCount; row++) {
      terms.push([emitIntegerAtLeast(circuit, [[scrollTop, 1], [topCells[row]!, -1]], 0, 0), 1])
    }
    firstRow = circuit.roundAffine(terms)
  } else {
    let low: Wire = circuit.affine([], 0)
    for (let step = 2 ** Math.floor(Math.log2(Math.max(1, rowCount - 1))); step >= 1; step /= 2) {
      // Past the table the read clamps to the total height, which is above any scrollTop.
      const candidateTop = circuit.indexReadAffine([[low, 1]], step, topCells, 'clamp', 'clamp')
      const take = emitIntegerAtLeast(circuit, [[scrollTop, 1], [candidateTop, -1]], 0, 0)
      low = circuit.roundAffine([[low, 1], [take, step]])
      circuit.assumeRange(low, 0, rowCount - 1)
    }
    firstRow = low
  }
  circuit.assumeRange(firstRow, 0, rowCount - 1)
  const members = construction === 'one-hot'
    ? emitIntegerOneHot(circuit, [[firstRow, 1]], 0, rowCount, false)
    : []
  const readRow = (table: readonly Wire[], tablePadding: readonly Wire[], slot: number, above: 'clamp' | 'zero') => {
    if (construction === 'instruction') return circuit.indexReadAffine([[firstRow, 1]], slot, table, 'clamp', above)
    const shifted = Array.from({length: rowCount}, (_, position) =>
      position + slot < table.length ? table[position + slot]! : tablePadding[position + slot - table.length]!)
    return emitMaskedRead(circuit, members, shifted)
  }
  const roots: Wire[] = [firstRow]
  for (let slot = 0; slot < slotCount; slot++) {
    const present = emitIntegerAtLeast(circuit, [[firstRow, -1]], rowCount - 1 - slot, 0)
    const top = readRow(topCells, topPadding, slot, 'clamp')
    const translateY = circuit.roundAffine([[top, 1], [scrollTop, -1]])
    roots.push(present, translateY)
    for (let field = 0; field < fieldCount; field++) roots.push(readRow(columns[field]!, padding[field] ?? [], slot, 'zero'))
  }
  return {circuit, layout, roots, scrollTop, total}
}

export function referenceVariableRowList(options: VirtualListOptions, scrollTop: number): number[] {
  const {rowCount, fieldCount, slotCount} = options
  let firstRow = 0
  let top = 0
  while (firstRow < rowCount - 1 && top + rowHeightAt(firstRow) <= scrollTop) {
    top += rowHeightAt(firstRow)
    firstRow++
  }
  const outputs = [firstRow]
  let slotTop = top
  for (let slot = 0; slot < slotCount; slot++) {
    const row = firstRow + slot
    outputs.push(row < rowCount ? 1 : 0, slotTop - scrollTop)
    for (let field = 0; field < fieldCount; field++) outputs.push(row < rowCount ? rowField(row, field) : 0)
    if (row < rowCount) slotTop += rowHeightAt(row)
  }
  return outputs
}

// ---------------------------------------------------------------- filtered list

// A list of itemCount items with a runtime visibility bit each (a filter),
// shown in slotCount slots: slot k shows the value of the (k + 1)-th visible
// item, or 0 with present = 0 when fewer items are visible. Outputs are every
// slot's value, then every slot's present bit.
// - one-hot: phase 1's bounded visibility compaction (constructions.ts): for
//   every item, count the earlier visible items with one wide sum, then one
//   equality bit per item and slot, declared as one group per slot, and gather
//   reads.
// - instruction: prefix counts of the bits by a Kogge-Stone parallel prefix
//   (exact on integers), then each slot binary searches the counts for the first
//   item whose count reaches k + 1, and reads that item's value.
export function buildFilteredList(itemCount: number, slotCount: number, construction: Construction) {
  const layout = new SourceLayout()
  const visible = layout.cells(itemCount, () => 0, 0, 1)
  const values = layout.cells(itemCount, item => item, 0, 16_384)
  const circuit = layout.createCircuit()
  const roots: Wire[] = []
  if (construction === 'one-hot') {
    const slotBits: Wire[][] = Array.from({length: slotCount}, () => [])
    for (let item = 0; item < itemCount; item++) {
      const earlierVisible = item === 0
        ? circuit.affine([], 0)
        : circuit.affine(Array.from({length: item}, (_, earlier): [Wire, number] => [visible[earlier]!, 1]))
      circuit.assumeRange(earlierVisible, 0, item)
      const atLeast: Wire[] = [circuit.affine([], 1)]
      for (let slot = 1; slot <= slotCount; slot++) {
        const difference = circuit.affine([[earlierVisible, 1]], 1 - slot)
        const bit = circuit.affine([
          [emitReluForm(circuit, [[difference, 1]]), 1],
          [emitReluForm(circuit, [[difference, 1]], -1), -1],
        ])
        circuit.assumeRange(bit, 0, 1)
        atLeast.push(bit)
      }
      for (let slot = 0; slot < slotCount; slot++) {
        const countIsSlot = circuit.roundAffine([[atLeast[slot]!, 1], [atLeast[slot + 1]!, -1]])
        circuit.assumeRange(countIsSlot, 0, 1)
        slotBits[slot]!.push(circuit.multiply(visible[item]!, countIsSlot))
      }
    }
    for (const group of slotBits) circuit.assumeOneHot(group, true)
    roots.push(...slotBits.map(group =>
      circuit.affine(group.map((bit, item) => [circuit.multiply(bit, values[item]!), 1] as const))))
    roots.push(...slotBits.map(group => circuit.affine(group.map(bit => [bit, 1] as const))))
  } else {
    let counts: Wire[] = [...visible]
    for (let span = 1; span < itemCount; span *= 2) {
      const level = counts
      counts = level.map((wire, item) => item >= span ? circuit.roundAffine([[level[item - span]!, 1], [wire, 1]]) : wire)
    }
    counts.forEach((count, item) => circuit.assumeRange(count, 0, item + 1))
    const total = counts[itemCount - 1]!
    const steps = Math.ceil(Math.log2(itemCount + 1))
    const slotValues: Wire[] = []
    const slotPresent: Wire[] = []
    for (let slot = 0; slot < slotSlots(slotCount); slot++) {
      // position = how many items have a count below slot + 1, found one bit at
      // a time. Past the table the read clamps to the total count.
      let position: Wire = circuit.affine([], 0)
      for (let step = 2 ** (steps - 1); step >= 1; step /= 2) {
        const count = circuit.indexReadAffine([[position, 1]], step - 1, counts, 'clamp', 'clamp')
        const take = emitIntegerAtLeast(circuit, [[count, -1]], slot, 0)
        position = circuit.roundAffine([[position, 1], [take, step]])
        circuit.assumeRange(position, 0, 2 ** steps - 1)
      }
      slotValues.push(circuit.indexRead(position, values, {outOfRange: 'zero'}))
      slotPresent.push(emitIntegerAtLeast(circuit, [[total, 1]], -(slot + 1), 0))
    }
    roots.push(...slotValues, ...slotPresent)
  }
  return {circuit, layout, roots, visible, values}
}

function slotSlots(slotCount: number) {
  return slotCount
}

export function referenceFilteredList(itemCount: number, slotCount: number, visibleBits: readonly number[]): number[] {
  const shown: number[] = []
  for (let item = 0; item < itemCount && shown.length < slotCount; item++) {
    if (visibleBits[item] === 1) shown.push(item)
  }
  const values = Array.from({length: slotCount}, (_, slot) => (slot < shown.length ? shown[slot]! : 0))
  const present = Array.from({length: slotCount}, (_, slot) => (slot < shown.length ? 1 : 0))
  return [...values, ...present]
}

// ---------------------------------------------------------------- photo strip

export type StripConstruction = 'source-one-hot' | Construction

export function aspectAt(photo: number) {
  return f(0.5 + ((photo * 40503) % 61) / 32)
}

// A 1D strip of photos with per-photo aspect ratios and a runtime strip height:
// width_i = height * aspect_i, left_i = height * aspectPrefix_i + gap * i. The
// strip is shifted so the focused photo is centered: offset = viewportWidth / 2
// - left_focused - width_focused / 2, which reads two computed tables at the
// focused index. 'source-one-hot' keeps focus as one bit per photo in the source
// table, like IndirectOS Photos does.
export function buildPhotoStrip(photoCount: number, construction: StripConstruction) {
  const layout = new SourceLayout()
  const stripHeight = layout.cell(120, 16, 1024)
  const viewportWidth = layout.cell(1280, 0, 16_384)
  const gap = layout.cell(12, 0, 64)
  const focus = construction === 'source-one-hot'
    ? layout.cells(photoCount, photo => (photo === 0 ? 1 : 0), 0, 1)
    : [layout.cell(0, 0, photoCount - 1)]
  const aspects = layout.cells(photoCount, aspectAt, 0.25, 4)
  const aspectPrefix: number[] = [0]
  for (let photo = 0; photo < photoCount; photo++) aspectPrefix.push(f(aspectPrefix[photo]! + aspectAt(photo)))
  const prefixCells = layout.cells(photoCount, photo => aspectPrefix[photo]!, 0, 4 * photoCount)
  const circuit = layout.createCircuit()
  if (construction === 'source-one-hot') circuit.assumeOneHot(focus)
  const widths = aspects.map(aspect => circuit.multiply(stripHeight, aspect))
  const lefts = prefixCells.map((prefixCell, photo) =>
    circuit.roundAffine([[circuit.multiply(stripHeight, prefixCell), 1], [gap, photo]]))
  for (const left of lefts) circuit.assumeRange(left, 0, 1024 * 4 * photoCount + 64 * photoCount)
  let focusedLeft: Wire
  let focusedWidth: Wire
  if (construction === 'instruction') {
    focusedLeft = circuit.indexRead(focus[0]!, lefts)
    focusedWidth = circuit.indexRead(focus[0]!, widths)
  } else {
    const members = construction === 'source-one-hot' ? focus : emitClampedOneHot(circuit, focus[0]!, photoCount)
    focusedLeft = emitMaskedRead(circuit, members, lefts)
    focusedWidth = emitMaskedRead(circuit, members, widths)
  }
  const offset = circuit.roundAffine([[viewportWidth, 0.5], [focusedLeft, -1], [focusedWidth, -0.5]])
  const translateX = lefts.map(left => circuit.roundAffine([[left, 1], [offset, 1]]))
  return {circuit, layout, roots: [offset, ...translateX, ...widths], focus, stripHeight, viewportWidth, gap}
}

export function referencePhotoStrip(
  photoCount: number,
  focused: number,
  stripHeight: number,
  viewportWidth: number,
  gap: number,
): number[] {
  const widths: number[] = []
  const lefts: number[] = []
  let aspectPrefix = 0
  for (let photo = 0; photo < photoCount; photo++) {
    widths.push(f(stripHeight * aspectAt(photo)))
    lefts.push(f(f(f(stripHeight * aspectPrefix)) + f(gap * photo)))
    aspectPrefix = f(aspectPrefix + aspectAt(photo))
  }
  const offset = f(f(f(f(0.5 * viewportWidth)) + f(-lefts[focused]!)) + f(-0.5 * widths[focused]!))
  return [offset, ...lefts.map(left => f(f(left) + offset)), ...widths]
}

// The thumbnail strip targets of IndirectOS Photos (photo-gallery.ts:279-319):
// each thumbnail's offset, distance, and spread relative to the focused photo,
// wrapped around the strip and clipped to |offset| < 5. Photos writes each as
// sum over focusedItem of focus[focusedItem] * constant(item, focusedItem), so
// photoCount^2 constants per field. The instruction form stores one table per
// field over the relative position, repeated twice so that item - focused +
// photoCount is always inside one contiguous run of cells.
export function thumbnailFalloff(distance: number) {
  return Math.max(0, 1 - 0.22 * distance)
}

export function thumbnailSpread(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) spread += (thumbnailFalloff(step - 1) + thumbnailFalloff(step)) / 2
  return spread
}

export function thumbnailFields(item: number, focusedItem: number, photoCount: number): [number, number, number] {
  let offset = item - focusedItem
  if (offset > photoCount / 2) offset -= photoCount
  if (offset < -photoCount / 2) offset += photoCount
  const visibleOffset = Math.abs(offset) < 5 ? offset : 0
  return [visibleOffset, Math.abs(offset), Math.sign(visibleOffset) * thumbnailSpread(Math.abs(visibleOffset))]
}

export type ThumbnailConstruction = 'source-one-hot-constants' | 'instruction'

export function buildThumbnailTargets(photoCount: number, construction: ThumbnailConstruction) {
  const layout = new SourceLayout()
  const focus = construction === 'source-one-hot-constants'
    ? layout.cells(photoCount, photo => (photo === 0 ? 1 : 0), 0, 1)
    : [layout.cell(0, 0, photoCount - 1)]
  // Table cell k holds the fields for relative position k - photoCount, for k
  // in 0..2 * photoCount - 1. The fields depend only on item - focusedItem.
  const tables = construction === 'instruction'
    ? [0, 1, 2].map(field => layout.cells(2 * photoCount, cell =>
        thumbnailFields(cell - photoCount, 0, photoCount)[field]!, -photoCount, photoCount))
    : []
  const circuit = layout.createCircuit()
  const roots: Wire[] = []
  for (let item = 0; item < photoCount; item++) {
    for (let field = 0; field < 3; field++) {
      if (construction === 'instruction') {
        roots.push(circuit.indexReadAffine([[focus[0]!, -1]], item + photoCount, tables[field]!, 'clamp', 'clamp'))
      } else {
        roots.push(circuit.affine(focus.map((bit, focusedItem) =>
          [bit, thumbnailFields(item, focusedItem, photoCount)[field]!] as const)))
      }
    }
  }
  return {circuit, layout, roots, focus}
}
