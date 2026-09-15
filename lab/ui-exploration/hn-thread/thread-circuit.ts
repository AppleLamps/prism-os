// The thread's render path as one circuit. Each section mirrors a block of
// thread-frame.ts (the hn.js-derived reference), rewritten without loops,
// searches, or tree walks:
// - comment heights: one comparison of the window width per prepared breakpoint
// - collapse: a count of collapsed ancestors, from a static ancestor table
// - row tops: prefix sums (one wide sum per row, or a Brent-Kung scan)
// - pointed row: a count of row bottoms above the pointer; its one-hot is the difference of neighboring bits
// - ancestor search: a static table [row][indent level], read through the row and level one-hots
// - gutter bottoms: the top of the row after the subtree, which is plain wiring
// - DOM slots: rows ranked by a prefix count of occupancy bits, routed into slotCount outputs
// Decisions (pointed row, gutter, ancestor, collapse, shrink, visibility, slots) are exact bits.

import {Circuit, type Terms, type Wire} from '../../../numeric-ui-core.ts'
import type {Staircase} from './text-heights.ts'
import {
  globalFrameFields, rowFrameFields, slotFrameFields,
  type FrameInputs, type GlobalFrame, type RowFrame, type SlotFrame, type SlotMode, type ThreadFrame, type ThreadState,
} from './thread-frame.ts'
import {threadLayout, type ThreadTables} from './thread-model.ts'

export type CircuitModel = {
  tables: ThreadTables
  staircases: readonly Staircase[]
}

export type PrefixMethod = 'fold' | 'brent-kung'

export type ThreadCircuitOptions = {
  slotCount: number
  slotMode: SlotMode
  // Natural heights are integers, so any summation order is exact.
  naturalPrefix: PrefixMethod
  // Animated heights are fractional; 'fold' matches a sequential Math.fround fold bit for bit.
  visualPrefix: PrefixMethod
}

export const defaultCircuitOptions: ThreadCircuitOptions = {slotCount: 48, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'}

const globalCells = [
  'windowWidth', 'windowHeight', 'scrollTopReal', 'pointerX', 'pointerY', 'pointerDown', 'click',
  'scrollTopPrevious', 'scrollDeltaPrevious', 'scrollerPeekUp', 'containerWidthPrevious',
] as const
type GlobalCell = typeof globalCells[number]

export type SourceLayout = {
  size: number
  cell: Record<GlobalCell, number>
  collapsed: number
  restHeights: number
  heights: number
  restTargetsPrevious: number
}

export function sourceLayout(rowCount: number): SourceLayout {
  const cell = Object.fromEntries(globalCells.map((name, index) => [name, index])) as Record<GlobalCell, number>
  const start = globalCells.length
  return {
    size: start + 4 * rowCount,
    cell,
    collapsed: start,
    restHeights: start + rowCount,
    heights: start + 2 * rowCount,
    restTargetsPrevious: start + 3 * rowCount,
  }
}

// Magnitude bounds. Comparison scales come from these, not from propagated ranges.
const heightBound = 8192 // one row; the longest comment at 375px is 3,726px
const positionBound = 65536 // content; 251 comments at 375px are 48,658px
const pointerBound = 32768
const scrollBound = 131072
const collapseWeight = 16384 // larger than any row height, so one collapsed ancestor zeroes a row

export type Section = {name: string, firstWire: Wire, endWire: Wire}

export type BuiltThreadCircuit = {
  circuit: Circuit
  layout: SourceLayout
  options: ThreadCircuitOptions
  rowCount: number
  roots: Wire[]
  demoRoots: Wire[]
  globalOffset: Record<keyof GlobalFrame, number>
  rowOffset: Record<keyof RowFrame, number>
  slotOffset: Record<keyof SlotFrame, number>
  stateOffset: number
  sections: Section[]
  comparisonCount: number
}

export function buildThreadCircuit(model: CircuitModel, options: ThreadCircuitOptions = defaultCircuitOptions): BuiltThreadCircuit {
  const {tables, staircases} = model
  const rowCount = tables.rowCount
  const slotCount = options.slotCount
  if (options.slotMode !== 'rank' && options.slotMode !== 'window') throw new Error(`unknown slot mode ${String(options.slotMode)}`)
  if (options.naturalPrefix !== 'fold' && options.naturalPrefix !== 'brent-kung') throw new Error(`unknown prefix method ${String(options.naturalPrefix)}`)
  if (options.visualPrefix !== 'fold' && options.visualPrefix !== 'brent-kung') throw new Error(`unknown prefix method ${String(options.visualPrefix)}`)
  const layout = sourceLayout(rowCount)
  const cell = layout.cell
  const circuit = new Circuit(layout.size)
  const rows = Array.from({length: rowCount}, (_, row) => row)

  circuit.assumeRange(cell.windowWidth, 0, 8192)
  circuit.assumeRange(cell.windowHeight, 0, 8192)
  circuit.assumeRange(cell.scrollTopReal, -4096, scrollBound)
  circuit.assumeRange(cell.pointerX, -16384, 16384)
  circuit.assumeRange(cell.pointerY, -16384, 16384)
  circuit.assumeRange(cell.pointerDown, 0, 1)
  circuit.assumeRange(cell.click, 0, 1)
  circuit.assumeRange(cell.scrollTopPrevious, -4096, scrollBound)
  circuit.assumeRange(cell.scrollDeltaPrevious, -2 * scrollBound, 2 * scrollBound)
  circuit.assumeRange(cell.scrollerPeekUp, 0, 8192)
  circuit.assumeRange(cell.containerWidthPrevious, 0, 8192)
  for (const row of rows) {
    circuit.assumeRange(layout.collapsed + row, 0, 1)
    circuit.assumeRange(layout.restHeights + row, -heightBound, heightBound)
    circuit.assumeRange(layout.heights + row, -4 * scrollBound, heightBound)
    circuit.assumeRange(layout.restTargetsPrevious + row, 0, heightBound)
  }

  const sections: Section[] = []
  const mark = (name: string) => {
    const wire = circuit.sourceSize + circuit.operations.length
    const previous = sections[sections.length - 1]
    if (previous !== undefined) previous.endWire = wire
    sections.push({name, firstWire: wire, endWire: wire})
  }
  let comparisonCount = 0

  const term = (wire: Wire, coefficient = 1): [Wire, number] => [wire, coefficient]
  const affine = (terms: Terms, bias = 0) => circuit.affine(terms, bias)
  const round = (terms: Terms, bias = 0) => circuit.roundAffine(terms, bias)
  const relu = (terms: Terms, bias = 0) => circuit.reglu([], 1, terms, bias)
  const multiply = (left: Wire, right: Wire) => circuit.multiply(left, right)
  // Logical and of exact bits.
  const and = (...bits: Wire[]) => relu(bits.map(bit => term(bit)), 1 - bits.length)
  const negate = (terms: Terms): Terms => terms.map(([wire, coefficient]) => term(wire, -coefficient))
  const absolute = (terms: Terms) => affine([term(relu(terms)), term(relu(negate(terms)))])
  // min(wire, limit), written so a huge wire still gives exactly `limit`.
  const limitAbove = (wire: Wire, limit: number) => round([term(relu([term(wire, -1)], limit), -1)], limit)
  // Integer clamp to 0..1 of a sum of bits, i.e. logical or.
  const anyOf = (bits: Wire[]) => affine([term(relu(bits.map(bit => term(bit)))), term(relu(bits.map(bit => term(bit)), -1), -1)])
  const bitFromScore = (score: Wire) => {
    const clamped = affine([term(relu([term(score)])), term(relu([term(score)], -1), -1)])
    circuit.assumeRange(clamped, 0, 1)
    comparisonCount++
    return circuit.boolean(clamped)
  }
  // Power-of-two scale with scale * bound <= 2^22, so the clamp's plateau holds up to twice the bound.
  const scaleFor = (bound: number) => {
    let scale = 2 ** 16
    while (scale * bound > 2 ** 22) scale /= 2
    return scale
  }
  // [sum of terms + bias >= 0], resolved to 1/(2 * scale). `bound` is the largest positive value that matters.
  const atLeastZero = (terms: Terms, bias: number, bound: number) => {
    const scale = scaleFor(bound)
    return bitFromScore(round(terms.map(([wire, coefficient]) => term(wire, coefficient * scale)), bias * scale + 0.5))
  }
  // [sum of terms + bias > 0], resolved to 1/(2 * scale).
  const aboveZero = (terms: Terms, bias: number, bound: number) => {
    const scale = scaleFor(bound)
    return bitFromScore(round(terms.map(([wire, coefficient]) => term(wire, coefficient * scale)), bias * scale))
  }
  // [v >= 0] for an integer-valued v: relu(v + 1) - relu(v).
  const integerAtLeastZero = (terms: Terms, bias = 0) => affine([term(relu(terms, bias + 1)), term(relu(terms, bias), -1)])
  // Masked read over a declared one-hot group; the compiler lowers it to a gather.
  const gather = (members: readonly Wire[], values: readonly Wire[]) =>
    affine(members.map((member, index) => term(multiply(member, values[index]!))))
  const zero = round([], 0)

  const prefixSums = (values: readonly Wire[], method: PrefixMethod): Wire[] => {
    if (method === 'fold') {
      // One wide sum per output, terms in row order: the same rounding steps as a sequential loop.
      return [zero, ...values.map((_, index) => round(values.slice(0, index + 1).map(value => term(value))))]
    }
    const scan = [...values]
    const count = scan.length
    for (let distance = 1; distance < count; distance *= 2) {
      for (let index = 2 * distance - 1; index < count; index += 2 * distance) scan[index] = round([term(scan[index - distance]!), term(scan[index]!)])
    }
    let largest = 1
    while (largest * 2 < count) largest *= 2
    for (let distance = largest; distance >= 1; distance /= 2) {
      for (let index = 3 * distance - 1; index < count; index += 2 * distance) scan[index] = round([term(scan[index - distance]!), term(scan[index]!)])
    }
    return [zero, ...scan]
  }

  mark('comment heights from breakpoints')
  // A breakpoint found by bisection sits within 1e-6px above the true change; moving the threshold down by
  // 1/2048px makes a width exactly on a change land on the wider side, as pretext does.
  const textHeights = staircases.map(staircase => affine(
    staircase.steps.map(step => term(atLeastZero([term(cell.windowWidth)], -(step.containerWidth - 1 / 2048), 8192), step.delta)),
    staircase.baseHeight,
  ))

  mark('collapse and natural heights')
  const naturalHeights = rows.map(row => {
    const collapsedAncestors = tables.ancestors[row]!.map(ancestor => term(layout.collapsed + ancestor))
    const expanded = relu([
      term(textHeights[row]!),
      term(layout.collapsed + row, -collapseWeight),
      ...collapsedAncestors.map(([wire]) => term(wire, -collapseWeight)),
    ], threadLayout.rowHeightExtra)
    const collapsedVisible = relu([term(layout.collapsed + row), ...negate(collapsedAncestors)])
    return round([term(expanded), term(collapsedVisible, threadLayout.collapsedRowHeight)])
  })

  mark('natural prefix sums')
  const naturalPrefix = prefixSums(naturalHeights, options.naturalPrefix)
  const rowsHeightNatural = naturalPrefix[rowCount]!

  mark('scroll smoothing')
  const smoothingActive = aboveZero([term(limitAbove(absolute([term(cell.scrollDeltaPrevious)]), 1))], -0.01, 1)
  const smoothedOffset = round([term(cell.scrollTopPrevious, 0.55), term(cell.scrollTopReal, -0.55)])
  const scrollTop = round([term(cell.scrollTopReal), term(multiply(smoothingActive, smoothedOffset))])
  const nextScrollDeltaPrevious = round([term(scrollTop), term(cell.scrollTopPrevious, -1)])
  const scrollTopCap = relu([term(scrollTop)])

  mark('vertical sizing')
  const containerHeight = round([term(cell.windowHeight)], -(threadLayout.currentContainerTop + threadLayout.containerBottomGap))
  const slack = round([term(containerHeight), term(rowsHeightNatural, -1)], -threadLayout.submissionHeightNatural)
  const fits = aboveZero([term(slack)], 0, positionBound)
  const fitDelta = round([term(slack), term(relu([term(slack)], -threadLayout.submissionHeightDelta), -1)])
  const scrollNegative = relu([term(scrollTop, -1)])
  const scrollAbove40 = relu([term(scrollTop)], -threadLayout.submissionHeightDelta)
  const scrollWithin40 = round([term(scrollTopCap), term(scrollAbove40, -1)])
  const elseSubmissionHeight = round([term(scrollTop, -1), term(scrollAbove40)], threadLayout.submissionHeightNatural)
  const elseScrollerBase = round([term(containerHeight), term(elseSubmissionHeight, -1)])
  const overscroll = relu([term(scrollTop), term(rowsHeightNatural, -1), term(elseScrollerBase)])
  const choose = (on: Wire, off: Wire) => round([term(off), term(multiply(fits, round([term(on), term(off, -1)])))])
  const submissionHeight = choose(affine([term(fitDelta)], 100), elseSubmissionHeight)
  const submissionLine1Top = choose(affine([term(fitDelta, 0.3)], 24), affine([term(scrollNegative, 0.7), term(scrollWithin40, -0.3)], 24))
  const submissionLinesGap = choose(affine([term(fitDelta, 0.1)], 8), affine([term(scrollNegative, 0.3), term(scrollWithin40, -0.1)], 8))
  const scrollerHeightNatural = choose(rowsHeightNatural, round([term(elseScrollerBase), term(overscroll, -0.5)]))

  mark('hit test')
  const containerWidth = round([term(relu([term(cell.windowWidth)], -375)), term(relu([term(cell.windowWidth)], -1200), -1)], 375)
  const containerLeft = round([term(cell.windowWidth, 0.5), term(containerWidth, -0.5)])
  const pageXLocal = round([term(cell.pointerX), term(containerLeft, -1)])
  const pointerAtLeft = atLeastZero([term(pageXLocal)], 0, pointerBound)
  const pointerPastRight = atLeastZero([term(pageXLocal), term(containerWidth, -1)], 0, pointerBound)
  const insideX = relu([term(pointerAtLeft), term(pointerPastRight, -1)])
  const pointerAboveContainer = atLeastZero([term(cell.pointerY, -1)], threadLayout.currentContainerTop, pointerBound)
  const pointerBelowContainer = atLeastZero([term(cell.pointerY), term(containerHeight, -1)], -threadLayout.currentContainerTop, pointerBound)
  const pointerBelowSubmission = aboveZero([term(cell.pointerY), term(submissionHeight, -1)], -threadLayout.currentContainerTop, pointerBound)
  const previousRegion = and(insideX, pointerAboveContainer)
  const nextRegion = and(insideX, pointerBelowContainer)
  const currentRegion = relu([term(insideX), term(pointerBelowSubmission), term(pointerBelowContainer, -1)], -1)
  // The pointer in content coordinates, where natural row tops are integer prefix sums.
  const yContent = round([term(cell.pointerY), term(submissionHeight, -1), term(scrollTopCap)], -threadLayout.currentContainerTop)
  const pointerBelowStart = atLeastZero([term(yContent)], 0, positionBound)
  // rowAbove[i] = [pointer is at or below the bottom of row i] = [i < pointed row]
  const rowAbove = rows.map(row => atLeastZero([term(yContent), term(naturalPrefix[row + 1]!, -1)], 0, positionBound))
  const rowMembers = rows.map(row => affine([term(row === 0 ? pointerBelowStart : rowAbove[row - 1]!), term(rowAbove[row]!, -1)]))
  circuit.assumeOneHot(rowMembers, true)
  const onRows = relu([term(currentRegion), term(pointerBelowStart), term(rowAbove[rowCount - 1]!, -1)], -1)
  const pointedRow = affine(rowAbove.map(bit => term(bit)))
  const levelCount = tables.maxIndent + 1
  const levelAbove = Array.from({length: levelCount}, (_, level) => atLeastZero([term(pageXLocal)], -threadLayout.indentWidth * (level + 1), pointerBound))
  const levelMembers = levelAbove.map((bit, level) => level === 0 ? affine([term(bit, -1)], 1) : affine([term(levelAbove[level - 1]!), term(bit, -1)]))
  circuit.assumeOneHot(levelMembers, true)
  const indentPointed = affine(levelAbove.map(bit => term(bit)))
  const pointedIndent = affine(rowMembers.map((member, row) => term(member, tables.indents[row]!)))
  const gutterReach = integerAtLeastZero([term(pointedIndent), term(indentPointed, -1)])
  const gutter = and(onRows, gutterReach)
  const onRow = relu([term(onRows), term(gutterReach, -1)])
  const ancestorByLevel = levelMembers.map((_, level) => affine(rowMembers.map((member, row) => term(member, tables.ancestorAtLevel[row]![level]!))))
  const ancestor = gather(levelMembers, ancestorByLevel)
  circuit.assumeRange(ancestor, 0, rowCount - 1)

  mark('gutter peek')
  const peeking = and(cell.pointerDown, gutter)
  // ramp(j) = relu(ancestor - j) for j in -1..rowCount; [ancestor == j] is a second difference of ramps.
  const ramps = Array.from({length: rowCount + 2}, (_, offset) => relu([term(ancestor)], 1 - offset))
  const ramp = (j: number) => ramps[j + 1]!
  const ancestorMembers = rows.map(j => affine([term(ramp(j - 1)), term(ramp(j), -2), term(ramp(j + 1))]))
  circuit.assumeOneHot(ancestorMembers, true)
  // shrink[i] = peeking and [ancestor < i] and [i < pointed row], with [ancestor < i] = 1 - (ramp(i - 1) - ramp(i))
  const shrink = rows.map(row => row === 0
    ? zero
    : relu([term(peeking), term(ramp(row - 1), -1), term(ramp(row)), term(rowAbove[row]!)], -1))
  const prefixAtRow = gather(rowMembers, naturalPrefix.slice(0, rowCount))
  const prefixAfterRow = gather(rowMembers, naturalPrefix.slice(1))
  const prefixAtAncestor = gather(ancestorMembers, naturalPrefix.slice(0, rowCount))
  const prefixAfterAncestor = gather(ancestorMembers, naturalPrefix.slice(1))
  const naturalAtAncestor = gather(ancestorMembers, naturalHeights)
  // Sum of natural heights strictly between the ancestor and the pointed row (0 when they're the same row).
  const shrinkSum = relu([term(prefixAtRow), term(prefixAfterAncestor, -1)])
  const ancestorTopFinal = round([term(shrinkSum), term(prefixAtAncestor)])
  const ancestorOverhang = relu([term(scrollTop), term(submissionHeight, -1), term(ancestorTopFinal, -1)])
  const ancestorHeightFinal = round([term(naturalAtAncestor), term(ancestorOverhang, -1)])
  const peekRaw = round([term(scrollTop), term(ancestorTopFinal, -1)])
  const peekClamped = relu([term(peekRaw), term(relu([term(peekRaw), term(submissionHeight, -1)]), -1)])
  const peekFinal = multiply(peeking, peekClamped)
  const peekDelta = round([term(peekFinal), term(cell.scrollerPeekUp, -1)])
  const nextPeekUp = round([term(cell.scrollerPeekUp), term(peekDelta, 0.2)])
  const peekMoving = aboveZero([term(limitAbove(absolute([term(peekDelta)]), 1))], -0.005, 1)
  const scrollerHeight = round([term(scrollerHeightNatural), term(nextPeekUp)])
  const scrollerTop = round([term(submissionHeight), term(nextPeekUp, -1)])

  mark('collapse toggle')
  // The banner's natural sticky position in content coordinates: max(rowTop, min(scrollTopCap, rowBottom - 24)).
  const bannerStick = round([term(scrollTopCap), term(relu([term(scrollTopCap), term(prefixAfterRow, -1)], threadLayout.userHeightNatural), -1)])
  const bannerTop = round([term(bannerStick), term(relu([term(prefixAtRow), term(bannerStick, -1)]))])
  const toggleRegion = and(onRow, aboveZero([term(bannerTop), term(yContent, -1)], threadLayout.userHeightNatural, positionBound))
  const toggleClick = and(toggleRegion, cell.click)
  const nextCollapsed = rows.map(row => {
    const toggled = and(toggleClick, rowMembers[row]!)
    const both = and(layout.collapsed + row, toggled)
    return affine([term(layout.collapsed + row), term(toggled), term(both, -2)])
  })

  mark('height easing')
  const widthChanged = aboveZero([term(limitAbove(absolute([term(containerWidth), term(cell.containerWidthPrevious, -1)]), 1))], 0, 1)
  const ancestorPeek = rows.map(row => and(peeking, ancestorMembers[row]!))
  const nextHeights: Wire[] = []
  const nextRestHeights: Wire[] = []
  const movingTerms: [Wire, number][] = []
  for (const row of rows) {
    const natural = naturalHeights[row]!
    const shift = multiply(widthChanged, round([term(natural), term(layout.restTargetsPrevious + row, -1)]))
    const heightShifted = round([term(layout.heights + row), term(shift)])
    const restShifted = round([term(layout.restHeights + row), term(shift)])
    const keep = affine(row === 0 ? [term(ancestorPeek[row]!, -1)] : [term(shrink[row]!, -1), term(ancestorPeek[row]!, -1)], 1)
    const target = round([term(multiply(keep, natural)), term(multiply(ancestorPeek[row]!, ancestorHeightFinal))])
    const heightDelta = round([term(target), term(heightShifted, -1)])
    const restDelta = round([term(natural), term(restShifted, -1)])
    nextHeights.push(round([term(heightShifted), term(heightDelta, 0.2)]))
    nextRestHeights.push(round([term(restShifted), term(restDelta, 0.2)]))
    movingTerms.push(term(relu([term(heightDelta)])), term(relu([term(heightDelta, -1)])), term(relu([term(restDelta)])), term(relu([term(restDelta, -1)])))
  }
  const heightsMoving = aboveZero([term(limitAbove(affine(movingTerms), 1))], -0.001, 1)
  const scheduleNextRender = anyOf([smoothingActive, peekMoving, heightsMoving])

  mark('visual prefix sums')
  const gap = affine([...nextRestHeights.map(wire => term(wire)), ...nextHeights.map(wire => term(wire, -1))])
  const visualBase = round([term(gap), term(nextPeekUp), term(scrollTopCap, -1)])
  const relativeTops = prefixSums(nextHeights, options.visualPrefix)
  const tops = relativeTops.map(relative => round([term(visualBase), term(relative)]))
  const placeholderHeight = round([term(tops[rowCount]!), term(scrollTopCap)])

  mark('visual rows and gutters')
  const rowWires = rows.map(row => {
    const top = tops[row]!
    const bottom = tops[row + 1]!
    const height = nextHeights[row]!
    const userHeight = round([term(height), term(relu([term(height)], -threadLayout.userHeightNatural), -1)])
    // hn.js: userTop = clamp(rowTop, 0, rowBottom - userHeight) = max(rowTop, min(0, rowBottom - userHeight))
    const stickBelow = relu([term(userHeight), term(bottom, -1)])
    const offsetInRow = relu([term(stickBelow, -1), term(top, -1)])
    const userTop = round([term(top), term(offsetInRow)])
    const visible = and(atLeastZero([term(scrollerHeight), term(top, -1)], 0, positionBound), atLeastZero([term(bottom)], 0, positionBound))
    const commentHeight = relu([term(height), term(userHeight, -1)], -threadLayout.commentUserGapNatural)
    const fadeRaw = round([term(textHeights[row]!), term(commentHeight, -1)])
    const commentFadeSize = round([term(fadeRaw), term(relu([term(fadeRaw)], -2 * threadLayout.commentBottomGapNatural), -1)], threadLayout.commentBottomGapNatural)
    // hn.js 473-477: gutter top
    const nearBottom = atLeastZero([term(bottom, -1), term(userTop), term(userHeight)], 4, positionBound)
    const nearTop = atLeastZero([term(offsetInRow, -1)], 4, positionBound)
    const innerValue = round([term(userTop), term(userHeight), term(multiply(nearTop, affine([term(offsetInRow, -1)], 4)))])
    const outerValue = round([term(innerValue), term(multiply(nearBottom, round([term(bottom), term(innerValue, -1)])))])
    const gutterTop = relu([term(outerValue)])
    // hn.js 479-481: the loop over following deeper rows ends at the top of the row after the subtree
    const gutterBottom = round([term(gutterTop), term(relu([term(tops[tables.subtreeEnds[row]!]!), term(gutterTop, -1)], -4))])
    const gutterVisible = and(atLeastZero([term(scrollerHeight), term(gutterTop, -1)], 0, positionBound), atLeastZero([term(gutterBottom)], 0, positionBound))
    const tallEnough = atLeastZero([term(limitAbove(height, 1))], -threadLayout.slotMinimumHeight, 1)
    return {
      textHeight: textHeights[row]!,
      naturalHeight: naturalHeights[row]!,
      shrink: shrink[row]!,
      top,
      height,
      restHeight: nextRestHeights[row]!,
      collapsed: nextCollapsed[row]!,
      userTop,
      userHeight,
      userOpacity: round([term(userHeight, 1 / threadLayout.userHeightNatural)]),
      userTextOpacity: round([term(height, 1 / 16)], -1.5),
      commentTop: round([term(top)], threadLayout.userHeightNatural + threadLayout.commentUserGapNatural),
      commentHeight,
      commentFadeSize,
      visible,
      occupiesSlot: and(visible, tallEnough),
      emphasis: ancestorPeek[row]!,
      gutterTop,
      gutterBottom,
      gutterVisible,
      gutterEmphasis: and(gutter, ancestorMembers[row]!),
    } satisfies Record<keyof RowFrame, Wire>
  })

  mark('DOM slots')
  const slotRecord = (present: Wire, row: Wire, read: (field: keyof RowFrame) => Wire): Record<keyof SlotFrame, Wire> => ({
    present,
    row,
    userTop: read('userTop'),
    userHeight: read('userHeight'),
    userOpacity: read('userOpacity'),
    userTextOpacity: read('userTextOpacity'),
    commentTop: read('commentTop'),
    commentHeight: read('commentHeight'),
    commentFadeSize: read('commentFadeSize'),
    emphasis: read('emphasis'),
    collapsed: read('collapsed'),
  })
  let slotWires: Record<keyof SlotFrame, Wire>[]
  let slotOverflow: Wire
  if (options.slotMode === 'rank') {
    const occupancy = rowWires.map(row => row.occupiesSlot)
    const occupancyPrefix = prefixSums(occupancy, 'brent-kung')
    const slotMembers: Wire[][] = Array.from({length: slotCount}, () => [])
    for (const row of rows) {
      // key = rank among occupying rows, or at least slotCount for a row that doesn't occupy a slot
      const keyTerms: Terms = [term(occupancyPrefix[row]!), term(occupancy[row]!, -slotCount)]
      const keyRamps = Array.from({length: slotCount + 2}, (_, offset) => relu(keyTerms, slotCount + 1 - offset))
      for (let slot = 0; slot < slotCount; slot++) {
        slotMembers[slot]!.push(affine([term(keyRamps[slot]!), term(keyRamps[slot + 1]!, -2), term(keyRamps[slot + 2]!)]))
      }
    }
    for (const members of slotMembers) circuit.assumeOneHot(members, true)
    slotWires = slotMembers.map(members => slotRecord(
      affine(members.map(member => term(member))),
      affine(members.map((member, row) => term(member, row))),
      field => gather(members, rowWires.map(row => row[field])),
    ))
    slotOverflow = integerAtLeastZero([term(occupancyPrefix[rowCount]!)], -(slotCount + 1))
  } else {
    // The first visible row is the only visible row with no visible row before it. Slot s reads row (first + s)
    // through the same one-hot, shifted by s, so every slot costs only gather reads.
    const visibility = rowWires.map(row => row.visible)
    const visiblePrefix = prefixSums(visibility, 'brent-kung')
    const firstMembers = rows.map(row => relu([term(visibility[row]!), term(visiblePrefix[row]!, -1)]))
    circuit.assumeOneHot(firstMembers, true)
    slotWires = Array.from({length: slotCount}, (_, slot) => {
      const shifted = (field: keyof RowFrame) => rows.map(row => row + slot < rowCount ? rowWires[row + slot]![field] : zero)
      return slotRecord(
        gather(firstMembers, shifted('visible')),
        affine(firstMembers.map((member, row) => term(member, row + slot))),
        field => gather(firstMembers, shifted(field)),
      )
    })
    slotOverflow = integerAtLeastZero([term(visiblePrefix[rowCount]!)], -(slotCount + 1))
  }

  mark('cursor')
  const ancestorRelativeTop = gather(ancestorMembers, relativeTops.slice(0, rowCount))
  const ancestorOccluded = aboveZero([term(scrollTopCap), term(ancestorRelativeTop, -1)], 0, positionBound)
  const notDirectParent = integerAtLeastZero([term(pointedRow), term(ancestor, -1)], -2)
  const resizeCursor = relu([term(gutter), term(anyOf([ancestorOccluded, notDirectParent]))], -1)
  const cursorCode = affine([term(onRow), term(toggleRegion, 4), term(resizeCursor, 2), term(previousRegion, 3), term(nextRegion, 4)])
  const pointerOn = affine([term(onRow), term(gutter, 2), term(previousRegion, 3), term(nextRegion, 4)])
  mark('end')
  sections.pop()

  const globalWires: Record<keyof GlobalFrame, Wire> = {
    scrollTop,
    scrollTopCap,
    containerWidth,
    containerLeft,
    containerHeight,
    submissionHeight,
    submissionLine1Top,
    submissionLine2Top: round([term(submissionLine1Top), term(submissionLinesGap)], threadLayout.submissionLine1Height),
    searchLeft: round([term(containerWidth)], -(threadLayout.searchWidth + threadLayout.commentLeftGap)),
    searchTop: round([term(submissionHeight, 0.5)], -threadLayout.searchHeight / 2),
    scrollerTop,
    scrollerHeight,
    scrollerPeekUp: nextPeekUp,
    placeholderHeight,
    pointerOn,
    pointedRow,
    ancestor,
    toggleRegion,
    peeking,
    cursorCode,
    scheduleNextRender,
    slotOverflow,
  }

  const roots: Wire[] = []
  const demoRoots: Wire[] = []
  const globalOffset = {} as Record<keyof GlobalFrame, number>
  for (const field of globalFrameFields) {
    globalOffset[field] = roots.length
    roots.push(globalWires[field])
    demoRoots.push(globalWires[field])
  }
  const rowOffset = {} as Record<keyof RowFrame, number>
  const demoRowFields = new Set<keyof RowFrame>(['gutterTop', 'gutterBottom', 'gutterVisible', 'gutterEmphasis'])
  for (const field of rowFrameFields) {
    rowOffset[field] = roots.length
    for (const row of rows) {
      roots.push(rowWires[row]![field])
      if (demoRowFields.has(field)) demoRoots.push(rowWires[row]![field])
    }
  }
  const slotOffset = {} as Record<keyof SlotFrame, number>
  for (const field of slotFrameFields) {
    slotOffset[field] = roots.length
    for (const slot of slotWires) {
      roots.push(slot[field])
      demoRoots.push(slot[field])
    }
  }
  const stateOffset = roots.length
  const stateWires = [scrollTop, nextScrollDeltaPrevious, nextPeekUp, containerWidth, ...nextCollapsed, ...nextRestHeights, ...nextHeights, ...naturalHeights]
  roots.push(...stateWires)
  demoRoots.push(...stateWires)

  return {circuit, layout, options, rowCount, roots, demoRoots, globalOffset, rowOffset, slotOffset, stateOffset, sections, comparisonCount}
}

// Source cells in the order stateWires lists them.
function stateCells(layout: SourceLayout, rowCount: number) {
  const cells = [layout.cell.scrollTopPrevious, layout.cell.scrollDeltaPrevious, layout.cell.scrollerPeekUp, layout.cell.containerWidthPrevious]
  for (const start of [layout.collapsed, layout.restHeights, layout.heights, layout.restTargetsPrevious]) {
    for (let row = 0; row < rowCount; row++) cells.push(start + row)
  }
  return cells
}

export function writeState(source: Float32Array, layout: SourceLayout, state: ThreadState) {
  source[layout.cell.scrollTopPrevious] = state.scrollTopPrevious
  source[layout.cell.scrollDeltaPrevious] = state.scrollDeltaPrevious
  source[layout.cell.scrollerPeekUp] = state.scrollerPeekUp
  source[layout.cell.containerWidthPrevious] = state.containerWidthPrevious
  source.set(state.collapsed, layout.collapsed)
  source.set(state.restHeights, layout.restHeights)
  source.set(state.heights, layout.heights)
  source.set(state.restTargetsPrevious, layout.restTargetsPrevious)
}

export function writeInputs(source: Float32Array, layout: SourceLayout, inputs: FrameInputs) {
  source[layout.cell.windowWidth] = inputs.windowWidth
  source[layout.cell.windowHeight] = inputs.windowHeight
  source[layout.cell.scrollTopReal] = inputs.scrollTopReal
  source[layout.cell.pointerX] = inputs.pointerX
  source[layout.cell.pointerY] = inputs.pointerY
  source[layout.cell.pointerDown] = inputs.pointerDown
  source[layout.cell.click] = inputs.click
}

export function readThreadFrame(built: BuiltThreadCircuit, outputs: Float32Array): ThreadFrame {
  const rowCount = built.rowCount
  const slotCount = built.options.slotCount
  const global = {} as GlobalFrame
  for (const field of globalFrameFields) global[field] = outputs[built.globalOffset[field]]!
  const rows: RowFrame[] = []
  for (let row = 0; row < rowCount; row++) {
    const record = {} as RowFrame
    for (const field of rowFrameFields) record[field] = outputs[built.rowOffset[field] + row]!
    rows.push(record)
  }
  const slots: SlotFrame[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const record = {} as SlotFrame
    for (const field of slotFrameFields) record[field] = outputs[built.slotOffset[field] + slot]!
    slots.push(record)
  }
  const at = (offset: number, count: number) => Array.from(outputs.subarray(built.stateOffset + offset, built.stateOffset + offset + count))
  return {
    global,
    rows,
    slots,
    next: {
      scrollTopPrevious: outputs[built.stateOffset]!,
      scrollDeltaPrevious: outputs[built.stateOffset + 1]!,
      scrollerPeekUp: outputs[built.stateOffset + 2]!,
      containerWidthPrevious: outputs[built.stateOffset + 3]!,
      collapsed: at(4, rowCount),
      restHeights: at(4 + rowCount, rowCount),
      heights: at(4 + 2 * rowCount, rowCount),
      restTargetsPrevious: at(4 + 3 * rowCount, rowCount),
    },
  }
}

// Output positions when evaluating built.demoRoots: globals, then the four gutter fields per row, then slots, then state.
export function demoOffsets(built: BuiltThreadCircuit) {
  const globalCount = globalFrameFields.length
  const rowCount = built.rowCount
  const slotCount = built.options.slotCount
  const gutterFields = ['gutterTop', 'gutterBottom', 'gutterVisible', 'gutterEmphasis'] as const
  const global = Object.fromEntries(globalFrameFields.map((field, index) => [field, index])) as Record<keyof GlobalFrame, number>
  const gutter = Object.fromEntries(gutterFields.map((field, index) => [field, globalCount + index * rowCount])) as Record<typeof gutterFields[number], number>
  const slot = Object.fromEntries(slotFrameFields.map((field, index) => [field, globalCount + gutterFields.length * rowCount + index * slotCount])) as Record<keyof SlotFrame, number>
  return {global, gutter, slot}
}

export type ThreadMachine = {
  built: BuiltThreadCircuit
  source: Float32Array
  // Writes inputs, evaluates, copies next-state outputs into the source table, clears the click latch.
  step(inputs: FrameInputs): Float32Array
}

export function createThreadMachine(built: BuiltThreadCircuit, state: ThreadState, roots: readonly Wire[] = built.roots): ThreadMachine {
  const {circuit, layout, rowCount} = built
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(layout.size)
  writeState(source, layout, state)
  const cells = stateCells(layout, rowCount)
  const stateStart = roots === built.roots ? built.stateOffset : roots.length - cells.length
  return {
    built,
    source,
    step(inputs) {
      writeInputs(source, layout, inputs)
      const outputs = evaluate(source)
      for (let index = 0; index < cells.length; index++) source[cells[index]!] = outputs[stateStart + index]!
      source[layout.cell.click] = 0
      return outputs
    },
  }
}

export function programStats(built: BuiltThreadCircuit, roots: readonly Wire[] = built.roots) {
  const program = built.circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  let gatherTableEntries = 0
  let widestLayer = 0
  let booleans = 0
  let reglus = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    for (const read of layer.gatherReads) gatherTableEntries += read.candidatePositions.length
    widestLayer = Math.max(widestLayer, layer.outputSize)
    booleans += layer.booleanRows.length
    reglus += layer.gateRows.length
  }
  // Live operations, stored weights, and the deepest layer, per build section.
  const liveBySection = built.sections.map(section => ({name: section.name, liveOperations: 0, storedWeights: 0, deepestLayer: 0}))
  const sectionOf = (wire: Wire) => built.sections.findIndex(section => wire >= section.firstWire && wire < section.endWire)
  let available = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    const projectionRows = layer.outputSize + layer.gateRows.length
    for (let row = 0; row < projectionRows; row++) {
      const operationRow = row < layer.outputSize ? row : layer.gateRows[row - layer.outputSize]!
      const index = sectionOf(program.wireOrder[available + operationRow]!)
      if (index < 0) continue
      const entry = liveBySection[index]!
      if (row < layer.outputSize) {
        entry.liveOperations++
        entry.deepestLayer = Math.max(entry.deepestLayer, layerIndex + 1)
      }
      entry.storedWeights += layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!
    }
    available += layer.outputSize
  })
  return {
    program,
    sourceCells: program.sourceSize,
    operationsBuilt: built.circuit.operations.length,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    widestLayer,
    storedWeights,
    gatherReads,
    gatherTableEntries,
    booleans,
    reglus,
    roots: roots.length,
    liveBySection,
  }
}
