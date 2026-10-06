// A virtualized list inside one circuit. JS writes scrollTop and the viewport
// height of a native scroll container into the source table; the circuit decides
// which rows intersect the viewport and assigns them to a fixed pool of DOM slots.
//
// Slot assignment is stable: row r always lands in slot r mod slotCount while it
// stays visible, so a DOM node keeps its row (and any row-local DOM state) as the
// list scrolls, like chenguini's domCache keyed by id.
import {Circuit, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {
  SourceLayout,
  andBits,
  constant,
  emitFloorByInteger,
  emitPrefixSums,
  integerAtLeastOne,
  integerAtLeastZero,
  type PrefixMode,
} from './common.ts'

export const slotCount = 24
// scrollTop and row heights are multiples of 1/4 px. JS floors scrollTop onto
// that grid before writing it (list-demo.ts). The floor changes nothing when
// scrollTop is already in whole, half, or quarter pixels, e.g. device pixels at
// devicePixelRatio 1, 2, and 4. At ratios like 1.5 or 3, where device pixels are
// 2/3 or 1/3 px, it moves scrollTop down by less than 1/4 px.
export const scrollGrid = 4
export const dataMaximum = 65_535

export type DataRead = 'js' | 'oneHot'

export type ListVariant =
  | {kind: 'uniform', rowCount: number, rowHeight: number, dataRead: DataRead}
  | {kind: 'variable', rowCount: number, minimumHeight: number, maximumHeight: number, prefix: PrefixMode | 'js', dataRead: DataRead}

export type ListSlot = {row: Wire, y: Wire, present: Wire, data: Wire | undefined}

export type ListCircuit = {
  circuit: Circuit
  variant: ListVariant
  scrollTop: Wire
  viewportHeight: Wire
  // uniform: none; variable with prefix in the circuit: one height per row;
  // variable with prefix in JS: one bottom edge per row.
  rowCells: Wire[]
  dataCells: Wire[]
  slots: ListSlot[]
  totalHeight: Wire
  roots: Wire[]
  maximumViewportHeight: number
  maximumScrollTop: number
}

export function buildList(variant: ListVariant): ListCircuit {
  return variant.kind === 'uniform' ? buildUniformList(variant) : buildVariableList(variant)
}

function buildUniformList(variant: Extract<ListVariant, {kind: 'uniform'}>): ListCircuit {
  const {rowCount, rowHeight} = variant
  const layout = new SourceLayout()
  const maximumScrollTop = rowCount * rowHeight
  // At most slotCount rows can intersect a viewport of (slotCount - 1) rows.
  const maximumViewportHeight = (slotCount - 1) * rowHeight
  const scrollTop = layout.cell(0, maximumScrollTop)
  const viewportHeight = layout.cell(0, maximumViewportHeight)
  const dataCells = variant.dataRead === 'oneHot' ? layout.cells(rowCount, 0, dataMaximum) : []
  const circuit = layout.createCircuit()

  // first = floor(scrollTop / rowHeight), exact, then offset = first mod slotCount.
  const first = emitFloorByInteger(circuit, scrollTop, rowHeight, scrollGrid)
  circuit.assumeRange(first, 0, rowCount)
  const block = emitFloorByInteger(circuit, first, slotCount, 1)
  const offset = circuit.roundAffine([[first, 1], [block, -slotCount]])
  circuit.assumeRange(offset, 0, slotCount - 1)

  // Shared data for the one-hot read: ramp[k] = relu(k - first), and
  // [first <= r] = ramp[r + 1] - ramp[r]. Slot s's row one-hot over the rows
  // r = s, s + 24, ... is [first <= r] - [first <= r - 24].
  let ramps: Wire[] = []
  if (variant.dataRead === 'oneHot') {
    ramps = Array.from({length: rowCount + 1}, (_, k) => circuit.reglu([], 1, [[first, -1]], k))
  }
  const firstAtMost = (row: number): [Wire, number][] =>
    row < 0 ? [] : [[ramps[row + 1]!, 1], [ramps[row]!, -1]]

  const slots: ListSlot[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const wraps = integerAtLeastOne(circuit, [[offset, 1]], -slot) // [offset > slot]
    const row = circuit.roundAffine([[first, 1], [offset, -1], [wraps, slotCount]], slot)
    circuit.assumeRange(row, 0, rowCount + slotCount)
    const exists = integerAtLeastZero(circuit, [[row, -1]], rowCount - 1)
    const visible = integerAtLeastOne(circuit, [[scrollTop, scrollGrid], [viewportHeight, scrollGrid], [row, -scrollGrid * rowHeight]], 0)
    const present = andBits(circuit, [exists, visible])
    const y = circuit.roundAffine([[row, rowHeight]])
    let data: Wire | undefined
    if (variant.dataRead === 'oneHot') {
      const members: Wire[] = []
      const values: Wire[] = []
      for (let candidate = slot; candidate < rowCount; candidate += slotCount) {
        const member = circuit.roundAffine([...firstAtMost(candidate), ...firstAtMost(candidate - slotCount).map(([wire, coefficient]) => [wire, -coefficient] as [Wire, number])])
        members.push(member)
        values.push(dataCells[candidate]!)
      }
      circuit.assumeOneHot(members, true)
      data = circuit.affine(members.map((member, index) => [circuit.multiply(member, values[index]!), 1]))
    }
    slots.push({row, y, present, data})
  }
  const totalHeight = constant(circuit, rowCount * rowHeight)
  const roots = slots.flatMap(slot => slot.data === undefined ? [slot.row, slot.y, slot.present] : [slot.row, slot.y, slot.present, slot.data])
  return {circuit, variant, scrollTop, viewportHeight, rowCells: [], dataCells, slots, totalHeight, roots, maximumViewportHeight, maximumScrollTop}
}

function buildVariableList(variant: Extract<ListVariant, {kind: 'variable'}>): ListCircuit {
  const {rowCount, minimumHeight, maximumHeight} = variant
  const layout = new SourceLayout()
  const maximumScrollTop = rowCount * maximumHeight
  const maximumViewportHeight = (slotCount - 1) * minimumHeight
  const scrollTop = layout.cell(0, maximumScrollTop)
  const viewportHeight = layout.cell(0, maximumViewportHeight)
  const rowCells = variant.prefix === 'js'
    ? layout.cells(rowCount, 0, maximumScrollTop)
    : layout.cells(rowCount, minimumHeight, maximumHeight)
  const dataCells = variant.dataRead === 'oneHot' ? layout.cells(rowCount, 0, dataMaximum) : []
  const circuit = layout.createCircuit()

  const bottoms = variant.prefix === 'js' ? rowCells : emitPrefixSums(circuit, rowCells, variant.prefix)
  bottoms.forEach(bottom => circuit.assumeRange(bottom, 0, maximumScrollTop))
  const zero = constant(circuit, 0)
  const tops = [zero, ...bottoms.slice(0, -1)]

  // above[r] = [bottom[r] <= scrollTop]. Bottoms increase, so these bits read
  // 1...1 0...0 and the first visible row is their count.
  const above = bottoms.map(bottom => integerAtLeastZero(circuit, [[scrollTop, scrollGrid], [bottom, -scrollGrid]], 0))

  const slots: ListSlot[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const members: Wire[] = []
    const rowTerms: [Wire, number][] = []
    for (let candidate = slot; candidate < rowCount; candidate += slotCount) {
      // [first <= r < first + 24] = above[r - 24] - above[r], above[negative] = 1.
      const member = candidate < slotCount
        ? circuit.roundAffine([[above[candidate]!, -1]], 1)
        : circuit.roundAffine([[above[candidate - slotCount]!, 1], [above[candidate]!, -1]])
      members.push(member)
      rowTerms.push([member, candidate])
    }
    circuit.assumeOneHot(members, true)
    const mass = circuit.affine(members.map(member => [member, 1]))
    const row = circuit.affine(rowTerms)
    const y = circuit.affine(members.map((member, index) => [circuit.multiply(member, tops[slot + index * slotCount]!), 1]))
    circuit.assumeRange(y, 0, maximumScrollTop)
    const visible = integerAtLeastOne(circuit, [[scrollTop, scrollGrid], [viewportHeight, scrollGrid], [y, -scrollGrid]], 0)
    const present = andBits(circuit, [mass, visible])
    let data: Wire | undefined
    if (variant.dataRead === 'oneHot') {
      data = circuit.affine(members.map((member, index) => [circuit.multiply(member, dataCells[slot + index * slotCount]!), 1]))
    }
    slots.push({row, y, present, data})
  }
  const totalHeight = bottoms[rowCount - 1]!
  const roots = [...slots.flatMap(slot => slot.data === undefined ? [slot.row, slot.y, slot.present] : [slot.row, slot.y, slot.present, slot.data]), totalHeight]
  return {circuit, variant, scrollTop, viewportHeight, rowCells, dataCells, slots, totalHeight, roots, maximumViewportHeight, maximumScrollTop}
}

export type ListFrame = {rows: {slot: number, row: number, y: number, data: number | undefined}[], totalHeight: number}

export function createListRunner(list: ListCircuit) {
  const evaluate = list.circuit.createTensorEvaluator(list.roots)
  const source = new Float32Array(list.circuit.sourceSize)
  const positions = new Map<Wire, number>()
  list.roots.forEach((root, index) => positions.set(root, index))
  return {
    source,
    setRows(values: readonly number[]) {
      // uniform lists have no row cells; variable lists take heights or bottoms.
      if (list.variant.kind === 'variable' && list.variant.prefix === 'js') {
        let bottom = 0
        values.forEach((height, index) => {
          bottom += height
          source[list.rowCells[index]!] = bottom
        })
      } else {
        values.forEach((value, index) => { source[list.rowCells[index]!] = value })
      }
    },
    setData(values: readonly number[]) {
      values.forEach((value, index) => { source[list.dataCells[index]!] = value })
    },
    run(scrollTop: number, viewportHeight: number): ListFrame {
      source[list.scrollTop] = scrollTop
      source[list.viewportHeight] = viewportHeight
      const outputs = evaluate(source)
      const rows: ListFrame['rows'] = []
      list.slots.forEach((slot, slotIndex) => {
        if (outputs[positions.get(slot.present)!] !== 1) return
        rows.push({
          slot: slotIndex,
          row: outputs[positions.get(slot.row)!]!,
          y: outputs[positions.get(slot.y)!]!,
          data: slot.data === undefined ? undefined : outputs[positions.get(slot.data)!]!,
        })
      })
      const totalHeight = list.variant.kind === 'uniform' ? list.variant.rowCount * list.variant.rowHeight : outputs[positions.get(list.totalHeight)!]!
      return {rows, totalHeight}
    },
  }
}

// ---------- JS reference ----------

// chenguini's stack layout (draggable-cards swap-layout.ts stackLayout) and the
// occlusion test from scroll-anchor (index.ts:152): a row is drawn when
// `y + height > visibleTop && y < visibleBottom`.
export function stackLayout(rowSizes: readonly number[], paddingTop: number): number[] {
  const result: number[] = []
  let top = paddingTop
  for (const rowSize of rowSizes) {
    result.push(top)
    top += rowSize
  }
  return result
}

export function referenceVisibleRows(heights: readonly number[], tops: readonly number[], scrollTop: number, viewportHeight: number) {
  const visibleTop = scrollTop
  const visibleBottom = scrollTop + viewportHeight
  const rows: {row: number, y: number}[] = []
  for (let index = 0; index < heights.length; index++) {
    if (tops[index]! + heights[index]! > visibleTop && tops[index]! < visibleBottom) rows.push({row: index, y: tops[index]!})
  }
  return rows
}
