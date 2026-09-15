// After: the card row as three map stages written once, with reductions across cards between them.
//
//   map 'sizes'                   zoom, gap | naturalWidth, naturalHeight -> width, height, step
//   reduction: maximum            height -> tallest
//   reduction: prefix sum         step, starting at rowLeft -> left
//   map 'placement and hit test'  rowTop, tallest, pointerX, pointerY | left, width, height -> top, hit
//   reduction: first active       hit, gated by pointerPresent -> hoveredIndex, hoverPresent
//   map 'hovered'                 hoveredIndex, hoverPresent | index -> hovered
//
// Left of the bar are shared values, right of it the card's own fields. Every reduction adds in card
// order and rounds to FP32 after each step, the same steps as the constructions in cards-duplicated.ts,
// so both versions give bit-identical outputs.
import {aboveZero, atLeastZero, emitAllChecks, emitIntegerIsZero} from './bits.ts'
import {sharedRanges, type Card, type RowInput, type RowOutputs} from './cards-types.ts'
import {buildMapStage, measureCircuit, runMapStage} from './map-stage.ts'

const f = Math.fround
export const maximumCards = 2 ** 16

// The stages don't depend on the card count: the same program runs for 1 card or 60,000.
export function buildStagedRow() {
  const sizes = buildMapStage('sizes',
    {zoom: sharedRanges.zoom, gap: sharedRanges.gap},
    {naturalWidth: [1, 4096], naturalHeight: [1, 4096]},
    (circuit, shared, card) => {
      // The natural size is a per-card input now, so scaling it is a product instead of a weight.
      const width = circuit.multiply(shared.zoom, card.naturalWidth)
      const height = circuit.multiply(shared.zoom, card.naturalHeight)
      return {width, height, step: circuit.roundAffine([[width, 1], [shared.gap, 1]])}
    })

  const placement = buildMapStage('placement and hit test',
    {rowTop: sharedRanges.rowTop, tallest: [0, 8192], pointerX: sharedRanges.pointerX, pointerY: sharedRanges.pointerY},
    {left: [-(2 ** 24), 2 ** 24], width: [0, 8192], height: [0, 8192]},
    (circuit, shared, card) => {
      const top = circuit.roundAffine([[shared.rowTop, 1], [shared.tallest, 0.5], [card.height, -0.5]])
      const hit = emitAllChecks(circuit, [
        atLeastZero(circuit.roundAffine([[shared.pointerX, 1], [card.left, -1]])),
        aboveZero(circuit.roundAffine([[card.left, 1], [card.width, 1], [shared.pointerX, -1]])),
        atLeastZero(circuit.roundAffine([[shared.pointerY, 1], [top, -1]])),
        aboveZero(circuit.roundAffine([[top, 1], [card.height, 1], [shared.pointerY, -1]])),
      ])
      return {top, hit}
    })

  const hover = buildMapStage('hovered',
    {hoveredIndex: [0, maximumCards - 1], hoverPresent: [0, 1]},
    {index: [0, maximumCards - 1]},
    (circuit, shared, card) => {
      // This stage compares each card's index with the shared hovered index, instead of reading one bit of a one-hot.
      const isHoveredIndex = emitIntegerIsZero(circuit, [[shared.hoveredIndex, 1], [card.index, -1]])
      const hovered = circuit.reglu([], 1, [[isHoveredIndex, 1], [shared.hoverPresent, 1]], -1)
      circuit.assumeRange(hovered, 0, 1)
      return {hovered}
    })

  return {sizes, placement, hover}
}

export type StagedRow = ReturnType<typeof buildStagedRow>

// m = values[0], then m = fround(values[i] + max(0, fround(m - values[i]))): emitMaximum's FP32 steps, in order.
export function maximumInOrder(values: Float32Array): number {
  let running = values[0]!
  for (let index = 1; index < values.length; index++) {
    const next = values[index]!
    running = f(next + Math.max(0, f(running - next)))
  }
  return running
}

// before[i] = start + values[0] + ... + values[i - 1], one rounded addition at a time.
export function prefixSumsInOrder(values: Float32Array, start: number): Float32Array {
  const before = new Float32Array(values.length)
  let running = f(start)
  for (let index = 0; index < values.length; index++) {
    before[index] = running
    running = f(running + values[index]!)
  }
  return before
}

// The first item whose bit is 1, when the gate is 1. The index is 0 when there's none.
export function firstActive(bits: Float32Array, gate: number): {index: number, present: number} {
  if (gate === 1) {
    for (let index = 0; index < bits.length; index++) {
      if (bits[index] === 1) return {index, present: 1}
    }
  }
  return {index: 0, present: 0}
}

export function evaluateStagedRow(program: StagedRow, cards: readonly Card[], input: RowInput): RowOutputs {
  const count = cards.length
  const naturalWidth = Float32Array.from(cards, card => card.naturalWidth)
  const naturalHeight = Float32Array.from(cards, card => card.naturalHeight)
  const index = Float32Array.from(cards, (_, position) => position)

  const sized = runMapStage(program.sizes, {zoom: input.zoom, gap: input.gap}, {naturalWidth, naturalHeight}, count)
  const tallest = maximumInOrder(sized.height)
  const lefts = prefixSumsInOrder(sized.step, input.rowLeft)
  const placed = runMapStage(program.placement,
    {rowTop: input.rowTop, tallest, pointerX: input.pointerX, pointerY: input.pointerY},
    {left: lefts, width: sized.width, height: sized.height},
    count)
  const hit = firstActive(placed.hit, input.pointerPresent ? 1 : 0)
  const hovered = runMapStage(program.hover, {hoveredIndex: hit.index, hoverPresent: hit.present}, {index}, count)

  return {
    widths: sized.width,
    heights: sized.height,
    lefts,
    tops: placed.top,
    hovered: hovered.hovered,
    tallest,
    hoveredIndex: hit.index,
    hoverPresent: hit.present,
  }
}

export function stagedStageSizes(program: StagedRow) {
  return [program.sizes, program.placement, program.hover].map(stage => ({
    name: stage.name,
    ...measureCircuit(stage.circuit, Object.values<number>(stage.outputs)),
  }))
}
