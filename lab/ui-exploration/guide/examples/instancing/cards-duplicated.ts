// Before: the card row as one circuit, with the per-card arithmetic written out once per card.
//
// The builder is ordinary JavaScript that loops over the cards and appends each card's operations to
// one Circuit, the way lab/ui-exploration/gallery/gallery-circuit.ts appends each photo's. A card's
// natural size is a build-time constant, so it becomes a weight. The loops across cards (the tallest
// card, the running left edge, the first card under the pointer) become constructions whose operation
// count and depth grow with the card count.
import {Circuit, emitFirstActive, emitMaximum, type Wire} from '../../../../../numeric-ui-core.ts'
import {aboveZero, atLeastZero, emitAllChecks} from './bits.ts'
import {sharedCells, sharedRanges, type Card, type RowInput, type RowOutputs, type SharedCell} from './cards-types.ts'

// How the running left edge is written: 'chain' adds one card per operation (one layer per card);
// 'triangle' writes each left edge as its own sum of all earlier steps (one layer, n²/2 stored weights).
// Both add in card order, so both give the same FP32 values.
export type PrefixLowering = 'chain' | 'triangle'

export function buildDuplicatedRow(cards: readonly Card[], options: {prefixLowering?: PrefixLowering} = {}) {
  const prefixLowering = options.prefixLowering ?? 'chain'
  const circuit = new Circuit(sharedCells.length)
  const cell = {} as Record<SharedCell, Wire>
  sharedCells.forEach((name, wire) => {
    cell[name] = wire
    circuit.assumeRange(wire, sharedRanges[name][0], sharedRanges[name][1])
  })

  // Sizes, once per card. The card's natural size is a weight.
  const widths = cards.map(card => circuit.affine([[cell.zoom, card.naturalWidth]]))
  const heights = cards.map(card => circuit.affine([[cell.zoom, card.naturalHeight]]))
  const steps = widths.map(width => circuit.roundAffine([[width, 1], [cell.gap, 1]]))

  // The tallest card: tallest = max(tallest, height), in card order. Each step is 3 operations deep.
  let tallest = heights[0]!
  for (let index = 1; index < cards.length; index++) tallest = emitMaximum(circuit, tallest, heights[index]!)

  // Left edges: lefts[i] = rowLeft + steps[0] + ... + steps[i - 1], added in card order.
  const lefts: Wire[] = []
  if (prefixLowering === 'chain') {
    let running = cell.rowLeft
    for (const step of steps) {
      lefts.push(running)
      running = circuit.roundAffine([[running, 1], [step, 1]])
    }
  } else {
    cards.forEach((_, index) => {
      lefts.push(circuit.roundAffine([[cell.rowLeft, 1], ...steps.slice(0, index).map(step => [step, 1] as const)]))
    })
  }

  // Placement and hit test, once per card.
  const tops = heights.map(height => circuit.roundAffine([[cell.rowTop, 1], [tallest, 0.5], [height, -0.5]]))
  const hits = cards.map((_, index) => emitAllChecks(circuit, [
    atLeastZero(circuit.roundAffine([[cell.pointerX, 1], [lefts[index]!, -1]])),
    aboveZero(circuit.roundAffine([[lefts[index]!, 1], [widths[index]!, 1], [cell.pointerX, -1]])),
    atLeastZero(circuit.roundAffine([[cell.pointerY, 1], [tops[index]!, -1]])),
    aboveZero(circuit.roundAffine([[tops[index]!, 1], [heights[index]!, 1], [cell.pointerY, -1]])),
  ]))

  // The first card under the pointer: a tournament over the hit bits (maxima on the way up, routing on
  // the way down) that sends a single 1 to the first card whose bit is 1, or all zeros when no card is
  // hit or the pointer is absent. These bits are the hovered bits.
  const hovered = emitFirstActive(circuit, cell.pointerPresent, hits)
  const hoveredIndex = circuit.roundAffine(hovered.map((bit, index) => [bit, index] as const))
  const hoverPresent = circuit.roundAffine(hovered.map(bit => [bit, 1] as const))

  return {circuit, cell, count: cards.length, wires: {widths, heights, lefts, tops, hovered, tallest, hoveredIndex, hoverPresent}}
}

export type DuplicatedRow = ReturnType<typeof buildDuplicatedRow>

export function duplicatedRoots(row: DuplicatedRow): Wire[] {
  const {wires} = row
  return [...wires.widths, ...wires.heights, ...wires.lefts, ...wires.tops, ...wires.hovered, wires.tallest, wires.hoveredIndex, wires.hoverPresent]
}

// Compile once; each call writes the source table, evaluates every layer, and slices the outputs.
export function createDuplicatedRunner(row: DuplicatedRow): (input: RowInput) => RowOutputs {
  const evaluate = row.circuit.createTensorEvaluator(duplicatedRoots(row))
  const source = new Float32Array(row.circuit.sourceSize)
  const count = row.count
  return input => {
    for (const name of sharedCells) source[row.cell[name]] = name === 'pointerPresent' ? (input.pointerPresent ? 1 : 0) : input[name]
    const values = evaluate(source)
    const field = (position: number) => values.slice(position * count, (position + 1) * count)
    return {
      widths: field(0),
      heights: field(1),
      lefts: field(2),
      tops: field(3),
      hovered: field(4),
      tallest: values[5 * count]!,
      hoveredIndex: values[5 * count + 1]!,
      hoverPresent: values[5 * count + 2]!,
    }
  }
}
