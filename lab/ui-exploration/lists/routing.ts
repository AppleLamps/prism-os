// Capacity routing (bounded visibility compaction): many items each get a cheap
// visibility bit, and the first slotCount visible items are routed into a fixed
// number of expensive slots. This is GShard-style capacity routing with a
// running count, applied to UI: filtering a collection into a few DOM slots.
//
// Construction:
// - count[i] = number of visible items among 0..i (a prefix sum of exact bits)
// - atMost[i][c] = [count[i] <= c], which reads 1...1 0...0 along i
// - slot c's one-hot over items is atMost[i - 1][c] - atMost[i][c]: it marks the
//   item where the running count first passes c, i.e. the (c + 1)-th visible item
// - atMost[i][c] = relu(c + 1 - count[i]) - relu(c - count[i]), and consecutive c
//   share relus, so each item costs slotCount relus
import type {Circuit, Wire} from '../../../numeric-ui-core.ts'
import {SourceLayout, andBits, emitPrefixSums, integerAtLeastOne, integerAtLeastZero, type PrefixMode} from './common.ts'

export type RoutingOptions = {itemCount: number, slotCount: number, prefix: PrefixMode}

export type RoutingCircuit = {
  circuit: Circuit
  options: RoutingOptions
  lower: Wire
  upper: Wire
  pointerX: Wire
  values: Wire[]
  lefts: Wire[]
  widths: Wire[]
  slots: {index: Wire, present: Wire, value: Wire, left: Wire, width: Wire, hover: Wire}[]
  roots: Wire[]
  // Wires grouped by the part of the construction they belong to, for cost splits.
  parts: {visibility: Wire[], counts: Wire[], routing: Wire[]}
}

export const valueMaximum = 1023
export const leftMaximum = 4000
export const widthMaximum = 400

export function buildRouting(options: RoutingOptions): RoutingCircuit {
  const {itemCount, slotCount} = options
  const layout = new SourceLayout()
  const lower = layout.cell(0, valueMaximum + 1)
  const upper = layout.cell(0, valueMaximum + 1)
  const pointerX = layout.cell(-4096, 8192)
  const values = layout.cells(itemCount, 0, valueMaximum)
  const lefts = layout.cells(itemCount, 0, leftMaximum)
  const widths = layout.cells(itemCount, 1, widthMaximum)
  const circuit = layout.createCircuit()

  // The cheap per-item test: lower <= value < upper, on integers.
  const visible = values.map(value => andBits(circuit, [
    integerAtLeastZero(circuit, [[value, 1], [lower, -1]], 0),
    integerAtLeastOne(circuit, [[upper, 1], [value, -1]], 0),
  ]))
  const counts = emitPrefixSums(circuit, visible, options.prefix)
  counts.forEach((count, index) => circuit.assumeRange(count, 0, index + 1))

  // ramps[i][k] = relu(k - count[i]) for k = 1..slotCount; ramps[i][0] is 0.
  const atMost = counts.map(count => {
    const ramps = Array.from({length: slotCount + 1}, (_, k) => k === 0 ? undefined : circuit.reglu([], 1, [[count, -1]], k))
    return Array.from({length: slotCount}, (_, c): [Wire, number][] => {
      const terms: [Wire, number][] = [[ramps[c + 1]!, 1]]
      if (c > 0) terms.push([ramps[c]!, -1])
      return terms
    })
  })

  const routing: Wire[] = []
  const slots: RoutingCircuit['slots'] = []
  for (let c = 0; c < slotCount; c++) {
    const members = Array.from({length: itemCount}, (_, item) => {
      const current = atMost[item]![c]!
      const member = item === 0
        ? circuit.roundAffine(current.map(([wire, coefficient]) => [wire, -coefficient]), 1)
        : circuit.roundAffine([...atMost[item - 1]![c]!, ...current.map(([wire, coefficient]) => [wire, -coefficient] as [Wire, number])])
      return member
    })
    routing.push(...members)
    circuit.assumeOneHot(members, true)
    const present = circuit.roundAffine([...atMost[itemCount - 1]![c]!.map(([wire, coefficient]) => [wire, -coefficient] as [Wire, number])], 1)
    circuit.assumeRange(present, 0, 1)
    const index = circuit.affine(members.map((member, item) => [member, item]))
    const read = (cells: readonly Wire[]) => circuit.affine(members.map((member, item) => [circuit.multiply(member, cells[item]!), 1]))
    const value = read(values)
    const left = read(lefts)
    const width = read(widths)
    circuit.assumeRange(left, 0, leftMaximum)
    circuit.assumeRange(width, 0, widthMaximum)
    // The expensive slot path in this study is small on purpose: a hover test
    // against the routed item's interval. Its cost is reported separately.
    const hover = andBits(circuit, [
      present,
      integerAtLeastZero(circuit, [[pointerX, 1], [left, -1]], 0),
      integerAtLeastOne(circuit, [[left, 1], [width, 1], [pointerX, -1]], 0),
    ])
    slots.push({index, present, value, left, width, hover})
  }
  const roots = slots.flatMap(slot => [slot.index, slot.present, slot.value, slot.left, slot.width, slot.hover])
  return {circuit, options, lower, upper, pointerX, values, lefts, widths, slots, roots, parts: {visibility: visible, counts, routing}}
}

export type RoutingItem = {value: number, left: number, width: number}

export function writeRoutingSource(routing: RoutingCircuit, source: Float32Array, items: readonly RoutingItem[], lower: number, upper: number, pointerX: number) {
  source[routing.lower] = lower
  source[routing.upper] = upper
  source[routing.pointerX] = pointerX
  items.forEach((item, index) => {
    source[routing.values[index]!] = item.value
    source[routing.lefts[index]!] = item.left
    source[routing.widths[index]!] = item.width
  })
}

// JS reference: filter in order, keep the first slotCount matches.
export function referenceRouting(items: readonly RoutingItem[], lower: number, upper: number, slotCount: number, pointerX: number) {
  const slots: {index: number, item: RoutingItem, hover: boolean}[] = []
  for (let index = 0; index < items.length && slots.length < slotCount; index++) {
    const item = items[index]!
    if (item.value >= lower && item.value < upper) {
      slots.push({index, item, hover: pointerX >= item.left && pointerX < item.left + item.width})
    }
  }
  return slots
}
