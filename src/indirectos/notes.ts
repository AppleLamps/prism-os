// The Notes window's paragraph, flowing around the windows stacked above Notes,
// in the same circuit as the window manager. Ported from
// lab/ui-exploration/indirect-os-2's notes.ts (configuration 4, with the obstacles
// read from destinations), rewritten on cells.ts declarations and
// numeric-ui-core.ts's helpers. indirect-os-2 was removed on September 16, 2026, and
// stays at https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2
//
// Coordinates are local to the Notes content box. Each other window's destination
// rectangle, where the window is going, becomes an obstacle while the window is
// visible and stacked above Notes. Every band (one line tall) carves the column
// around the obstacles that overlap it vertically, keeps the widest remaining slot
// at least `minimumSlotWidth` wide (ties go to the slot further right), and a band
// with no slot lays out nothing. The line walker in notes-walker.ts then lays the
// paragraph out band by band over the runtime segment widths, and every word sits
// where this evaluation's walk puts it, with no spring and no stored state. So the
// text reflows once per event that changes a destination, e.g. once at a maximize
// press and not at every frame of the animation, and word positions are the same
// at every frame rate.
//
// The carving depends on the band only through which obstacles block it, so the
// slot is computed once for each subset of the obstacles (8 subsets of 3), and each
// band reads its subset's slot through a one-hot of its 3 blocking bits.
//
// Geometry comparisons are rounding comparisons: exact bits when a difference sits
// on a 1/64 px grid, and either answer within 1/128 px of a tie. Destinations come
// from stored geometry on that grid, so the bits are exact in practice.
//
// Behavior choices, see behavior-choices.md's "Flow text around destinations, in a
// fixed number of lines":
// - The obstacles are the windows that are visible after this evaluation's events,
//   at their destinations. So at a minimize or close press, the text reflows into
//   that window's area in the frame of the press, while the window is still drawn
//   on its way to the dock.
// - The flow has a fixed number of bands, 16 by default. Lines past the last usable
//   band aren't laid out: their words get visible = 0, and `truncated` is 1. E.g.
//   when Files covers all but an 85 px slot of the column, each band holds one or
//   two words, and the paragraph's last words aren't laid out.
// - A band whose bottom lies below the content box is unusable, so no word is
//   placed where the window would clip it. The content height is the destination
//   height, so this gate changes only at events, like the obstacles.
import {type Circuit, type Terms, type Wire, emitMaximum, emitMinimum, emitMultiply, emitRelu, emitSelect, invariant} from '../runtime/numeric-ui-core.ts'
import {type FastCircuit, attachFastCircuit, integerAtLeast, maximumSegmentWidth, segmentGeometry, walkGatheredLines} from './notes-walker.ts'
import {type CellWires, constant, input, inputBit} from '../runtime/cells.ts'
import type {FastParagraph} from './notes-walker.ts'
import type {NotesOptions} from './notes-paragraph.ts'

// The Notes window's index among IndirectOS's windows.
export const notesWindowIndex = 1
// Word and obstacle coordinates local to the content box stay within this range
// for any viewport within 0..16,384 px.
const localRange = [-32_768, 32_768] as const

// The machine rounds each width to 1/64 px, which keeps the walker's prefix sums
// exact in FP32.
const widthGrid = 1 / 64

// Notes' own cells: the paragraph's measured widths and break-after bits, which the
// host writes once, and the segment the paragraph starts at. Words carry no state.
export function notesCells(paragraph: FastParagraph) {
  invariant(paragraph.widths.length === paragraph.breakAfter.length, 'one break-after bit per segment')
  return {
    widths: paragraph.widths.map(width => input([0, maximumSegmentWidth], {initial: width, grid: widthGrid})),
    breakAfter: paragraph.breakAfter.map(breakAfter => inputBit(breakAfter)),
    startCursor: constant(0, [0, paragraph.widths.length]),
  }
}
type NotesCells = CellWires<ReturnType<typeof notesCells>>

type NotesContext = {
  unit: Wire
  titleHeight: Wire
  // Every window's destination rectangle and whether it's visible after this
  // evaluation's events, in the window order; the entry at notesWindowIndex is Notes.
  windows: readonly {destination: {left: Wire, top: Wire, width: Wire, height: Wire}, visible: Wire}[]
  // The stacking after this evaluation's events: nextStack[rank][windowIndex].
  nextStack: readonly (readonly Wire[])[]
  // The Notes content box's height at the window's destination.
  contentHeight: Wire
}

// Per word: x and y in the content box's coordinates, and whether a band laid it out.
export const wordOutputField = {x: 0, y: 1, visible: 2, size: 3} as const
// Per band: whether the band has a slot within the content box, the slot's left
// edge and width, and the segment its line starts at. These wires are live in the
// walker anyway, so reporting them costs no operations; the line's painted width
// would cost about 27 per band, and the words' positions check it.
export const bandOutputField = {usable: 0, left: 1, width: 2, start: 3, size: 4} as const

export type NotesOutputs = {
  words: Wire[]
  bands: Wire[]
  lineCount: Wire
  // 1 when the paragraph needs more bands than the flow has, or more than fit
  // in the content box, so some words aren't laid out.
  truncated: Wire
  // Nonzero when a line reaches past the walker's window, or when a run of
  // break-after segments is longer than the flow was built for; both mean the
  // options don't fit the paragraph.
  windowOverflow: Wire
  runOverflow: Wire
}

function textSegments(paragraph: FastParagraph) {
  return paragraph.breakAfter.flatMap((breakAfter, index) => breakAfter === 0 ? [index] : [])
}

export function buildNotes(circuit: Circuit, cells: NotesCells, options: NotesOptions, context: NotesContext): NotesOutputs {
  const {unit, titleHeight, nextStack, contentHeight} = context
  const {paragraph} = options
  invariant(cells.widths.length === paragraph.widths.length, 'the cells were declared for another paragraph')
  invariant(options.minimumSlotWidth >= Math.max(...paragraph.widths), 'every slot must fit the widest segment, so the fast path never needs an emergency break')
  invariant(context.windows.length > notesWindowIndex, 'the context needs the Notes window')
  const zero = circuit.constant(0)
  const affine = (terms: Terms, bias = 0) => circuit.affine(terms, bias)
  const assume = (wire: Wire, minimum: number, maximum: number) => {
    circuit.assumeRange(wire, minimum, maximum, {allowExistingReaders: true})
    return wire
  }
  // [expression >= threshold] for integer-valued terms, e.g. bits and ranks.
  const atLeast = (terms: Terms, threshold: number) => integerAtLeast(circuit, terms, 0, threshold)
  // [difference > 0] and [difference >= 0] for a difference in px given as terms:
  // the score 64 * difference + offset is clamped to 0..1 and rounded by the
  // boolean atom, which is exact for differences on the 1/64 px grid.
  const comparison = (terms: Terms, offset: number) => {
    const scoreTerms: [Wire, number][] = terms.map(([wire, coefficient]) => [wire, 64 * coefficient])
    if (offset !== 0) scoreTerms.push([unit, offset])
    const score = circuit.roundAffine(scoreTerms)
    const clamped = assume(affine([[emitRelu(circuit, score), 1], [emitRelu(circuit, affine([[score, 1], [unit, -1]])), -1]]), 0, 1)
    return circuit.boolean(clamped)
  }
  const greater = (terms: Terms) => comparison(terms, 0)
  const atLeastZero = (terms: Terms) => comparison(terms, 0.5)
  // Sum of bit * value over a declared one-hot group, which the compiler lowers to a gather read.
  const dot = (bits: readonly Wire[], values: readonly Wire[]) =>
    affine(bits.map((bit, index) => [emitMultiply(circuit, bit, values[index]!), 1]))

  // The obstacles: every other window, in the content box's coordinates.
  const rankOf = (windowIndex: number) => affine(nextStack.map((row, rank) => [row[windowIndex]!, rank]))
  const notes = context.windows[notesWindowIndex]!.destination
  const contentLeft = affine([[notes.left, 1], [unit, 1]])
  const contentTop = affine([[notes.top, 1], [titleHeight, 1], [unit, 1]])
  const columnWidth = assume(
    emitMinimum(circuit, emitRelu(circuit, affine([[notes.width, 1], [unit, -2 - 2 * options.padding]])), circuit.constant(options.maximumColumnWidth)),
    0,
    options.maximumColumnWidth,
  )
  const columnLeft = circuit.constant(options.padding)
  const obstacles = context.windows.flatMap((window, windowIndex) => {
    if (windowIndex === notesWindowIndex) return []
    const above = atLeast([[rankOf(windowIndex), 1], [rankOf(notesWindowIndex), -1]], 1)
    return [{
      left: assume(affine([[window.destination.left, 1], [contentLeft, -1]]), ...localRange),
      top: assume(affine([[window.destination.top, 1], [contentTop, -1]]), ...localRange),
      width: window.destination.width,
      height: window.destination.height,
      active: atLeast([[window.visible, 1], [above, 1]], 2),
    }]
  })

  // The slot of each subset of the obstacles: the widest stretch of the column that
  // no obstacle in the subset covers, at least minimumSlotWidth wide.
  const columnRight = affine([[columnLeft, 1], [columnWidth, 1]])
  const intervals = obstacles.map(obstacle => ({
    left: affine([[obstacle.left, 1], [unit, -options.horizontalPadding]]),
    right: affine([[obstacle.left, 1], [obstacle.width, 1], [unit, options.horizontalPadding]]),
  }))
  // Candidate slot starts: the column's left edge, and each interval's right edge.
  const starts = [columnLeft, ...intervals.map(interval => emitMaximum(circuit, interval.right, columnLeft))]
  // Band-independent comparisons between candidate starts and interval edges.
  const inside = starts.map(start => intervals.map(interval =>
    atLeast([[greater([[start, 1], [interval.left, -1]]), 1], [greater([[interval.right, 1], [start, -1]]), 1]], 2)))
  const ends = starts.map(start => intervals.map(interval =>
    emitSelect(circuit, atLeastZero([[interval.left, 1], [start, -1]]), columnRight, interval.left)))
  const subsetCount = 1 << obstacles.length
  const slots = Array.from({length: subsetCount}, (_, subset) => {
    const members = obstacles.map((_, index) => index).filter(index => (subset >> index & 1) === 1)
    const candidates = [0, ...members.map(index => index + 1)].map(candidate => {
      const covered = members.length === 0 ? zero : atLeast(members.map(member => [inside[candidate]![member]!, 1] as const), 1)
      const end = members.reduce<Wire>((narrowest, member) => emitMinimum(circuit, narrowest, ends[candidate]![member]!), columnRight)
      const width = emitRelu(circuit, affine([[end, 1], [starts[candidate]!, -1]]))
      return {start: starts[candidate]!, width, fits: atLeast([[atLeastZero([[width, 1], [unit, -options.minimumSlotWidth]]), 1], [covered, -1]], 1)}
    })
    // The widest slot that fits; ties go to the slot further right.
    let best = candidates[0]!
    for (const candidate of candidates.slice(1)) {
      const wider = greater([[candidate.width, 1], [best.width, -1]])
      const notNarrower = atLeastZero([[candidate.width, 1], [best.width, -1]])
      const righter = greater([[candidate.start, 1], [best.start, -1]])
      const equalAndRighter = atLeast([[notNarrower, 1], [wider, -1], [righter, 1]], 2)
      const better = atLeast([[unit, 1], [best.fits, -1], [wider, 1], [equalAndRighter, 1]], 1)
      const wins = atLeast([[candidate.fits, 1], [better, 1]], 2)
      best = {
        start: emitSelect(circuit, wins, best.start, candidate.start),
        width: emitSelect(circuit, wins, best.width, candidate.width),
        fits: atLeast([[best.fits, 1], [candidate.fits, 1]], 1),
      }
    }
    return {start: assume(best.start, ...localRange), width: assume(best.width, 0, options.maximumColumnWidth), fits: best.fits}
  })

  // Per band: which obstacles block it, its subset's slot, and the height gate.
  const bands = Array.from({length: options.bands}, (_, band) => {
    const bandTop = options.padding + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    // An obstacle blocks the band unless the band ends above it or starts below it (padded).
    const blocked = obstacles.map(obstacle => atLeast([
      [obstacle.active, 1],
      [greater([[unit, bandBottom + options.verticalPadding], [obstacle.top, -1]]), 1],
      [greater([[obstacle.top, 1], [obstacle.height, 1], [unit, options.verticalPadding - bandTop]]), 1],
    ], 3))
    const subsetOneHot = Array.from({length: subsetCount}, (_, subset) =>
      atLeast(blocked.map((bit, index) => [bit, (subset >> index & 1) === 1 ? 1 : -1] as const), popcount(subset)))
    circuit.assumeOneHot(subsetOneHot, false)
    const hasSlot = assume(dot(subsetOneHot, slots.map(slot => slot.fits)), 0, 1)
    const withinContent = atLeastZero([[contentHeight, 1], [unit, -bandBottom]])
    return {
      usable: atLeast([[hasSlot, 1], [withinContent, 1]], 2),
      left: dot(subsetOneHot, slots.map(slot => slot.start)),
      width: dot(subsetOneHot, slots.map(slot => slot.width)),
    }
  })

  // The line walker, band by band, then an x, a y and a visible bit per segment.
  const fc: FastCircuit = attachFastCircuit(
    circuit,
    unit,
    {startCursor: cells.startCursor, widthCells: cells.widths, breakAfterCells: cells.breakAfter},
    options.epsilon,
    options.runLimit,
  )
  const walk = walkGatheredLines(fc, options.window, bands.map(band => band.width), bands.map(band => band.usable))
  const geometry = segmentGeometry(fc, walk, bands.map(band => band.left), options.padding, options.lineHeight)

  const words = textSegments(paragraph).flatMap(segment => [geometry.x[segment]!, geometry.y[segment]!, geometry.visible[segment]!])
  const lastSegment = paragraph.widths.length - 1
  return {
    words,
    bands: bands.flatMap((band, index) => [band.usable, band.left, band.width, walk.starts[index]!]),
    lineCount: walk.lineCount,
    truncated: assume(affine([[unit, 1], [geometry.visible[lastSegment]!, -1]]), 0, 1),
    windowOverflow: walk.windowOverflow,
    runOverflow: fc.runOverflow,
  }
}

function popcount(value: number) {
  let count = 0
  for (let bits = value; bits > 0; bits >>= 1) count += bits & 1
  return count
}
