// The Notes window's paragraph, flowing around the windows stacked above Notes,
// with one spring per word, in the same circuit as the window manager.
//
// Coordinates are local to the Notes content box. Each other window's projected
// rectangle (this frame's animated geometry, or its stepped springs) becomes an
// obstacle while the window is drawn and stacked above Notes. Every band (one
// line tall) carves the column around the obstacles that overlap it vertically,
// keeps the widest remaining slot at least `minimumSlotWidth` wide (ties go to the
// slot further right, as dynamic-layout's layoutColumn), and a band with no slot
// lays out nothing.
//
// The carving depends on the band only through which obstacles block it, so the
// slot is computed once for each of the 8 subsets of the 3 obstacles, and each
// band reads its subset's slot through a one-hot of its 3 blocking bits.
// Obstacle geometry is fractional while windows animate, so geometry comparisons
// are rounding comparisons: exact bits when a difference sits on a 1/64 grid,
// either answer within 1/128 px of a tie.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import type {LayoutWires} from './desktop-latches.ts'
import {type FastParagraph, attachFastCircuit, longestBreakAfterRun, maximumSegmentWidth, segmentGeometry, walkGatheredLines} from './fast-walker.ts'
import {type Term, createKit} from './input-kit.ts'
import {type SpringClock, type SpringGroup, createConstantPowerGroup, emitSpringBox, withSection} from './spring-bank.ts'
import {type Allocated, type SourceTable, anyNumber, bit, constant, input, inputBit, list, state} from './table.ts'
import type {Notation, SpringParams} from './wires.ts'

export type NotesOptions = {
  paragraph: FastParagraph
  epsilon: number
  // The fast walker's window: segments compared after a line start, see fastWindow.
  window: number
  runLimit?: number
  bands: number
  lineHeight: number
  padding: number
  maximumColumnWidth: number
  horizontalPadding: number
  verticalPadding: number
  minimumSlotWidth: number
  springConstants: {stiffness: number, damping: number}
  // Where obstacles come from:
  // - 'current-frame': this frame's projected windows, as drawn
  // - 'stepped-springs': their stepped springs before the settle snap, with last
  //   frame's stacking and presence (early in the circuit, one frame behind during a drag)
  // - 'destinations': where the windows are going (their destination rectangles and
  //   visibility), so the text reflows to the final layout while windows animate
  obstacles: 'current-frame' | 'stepped-springs' | 'destinations'
}

export const notesWindowIndex = 1
const obstacleIndices = [0, 2, 3] as const
const localRange = [-32_768, 32_768] as const

export function textSegments(paragraph: FastParagraph) {
  return paragraph.breakAfter.flatMap((breakAfter, index) => breakAfter === 0 ? [index] : [])
}

// category: declarations
export function notesCells(options: NotesOptions) {
  const {paragraph} = options
  const words = textSegments(paragraph)
  return {
    widths: paragraph.widths.map(width => input([0, maximumSegmentWidth], width)),
    breakAfter: paragraph.breakAfter.map(breakAfter => inputBit(breakAfter)),
    startCursor: constant(0, [0, paragraph.widths.length]),
    initialized: bit(),
    words: words.map(() => ({position: {x: state(localRange), y: state(localRange)}, velocity: {x: state(anyNumber), y: state(anyNumber)}})),
    // The destination each word stepped toward last frame (spring bank, deferred retargeting).
    destinations: words.map(() => ({x: state(localRange), y: state(localRange)})),
  }
}
export type NotesCells = Allocated<ReturnType<typeof notesCells>>

export type NotesWindow = {
  translateX: Wire, translateY: Wire, width: Wire, height: Wire,
  centerX: Wire, centerY: Wire, scaledHalfWidth: Wire, scaledHalfHeight: Wire,
  // nextPresent this frame, and the stored present cell from last frame.
  opacity: Wire, present: Wire,
  // The window's lanes after stepping, before the settle snap (bank only).
  stepped: readonly Wire[] | null
  // Where the window is going: its destination rectangle and visibility this frame.
  destination: {left: Wire, top: Wire, width: Wire, height: Wire}
  visible: Wire
}

export type NotesContext = {
  layout: LayoutWires
  windows: readonly NotesWindow[]
  nextStack: readonly (readonly Wire[])[]
  stack: readonly (readonly Wire[])[]
  notesVisible: Wire
  group: {kind: 'original', params: SpringParams} | {kind: 'bank', clock: SpringClock, settleDistance: Wire, settleSpeed: Wire}
}

export type NotesBuild = ReturnType<typeof buildNotes>

// category: behavior
export function buildNotes($: Notation, table: SourceTable, cells: NotesCells, options: NotesOptions, context: NotesContext) {
  const {sum, sub, half, relu, mul, min, max, clamp, select, zero, unit, assume, circuit} = $
  const kit = createKit(circuit)
  const {layout} = context
  const {viewportWidth, viewportHeight, titleHeight} = layout
  invariant(options.minimumSlotWidth >= Math.max(...options.paragraph.widths), 'every slot must fit the widest segment, so the fast path never needs an emergency break')

  // [value > 0] and [value >= 0] for a difference given as terms.
  const comparison = (terms: readonly Term[], offset: number) => {
    const score = circuit.roundAffine([...terms.map(([wire, coefficient]) => [wire, 64 * coefficient] as const), [unit, offset]])
    return circuit.boolean(assume(sum(relu(score), [relu(sum(score, [unit, -1])), -1]), 0, 1))
  }
  const greater = (terms: readonly Term[]) => comparison(terms, 0)
  const atLeastZero = (terms: readonly Term[]) => comparison(terms, 0.5)

  const {obstacles, column} = withSection(circuit, 'notes obstacles', () => {
    const current = options.obstacles !== 'stepped-springs'
    // A window's drawn rectangle: scaled about its center.
    const drawn = (window: NotesWindow) => {
      if (options.obstacles === 'destinations') {
        const {left, top, width, height} = window.destination
        return {left, top, width, height, box: {left, top, width}}
      }
      if (current) return {left: sub(window.centerX, window.scaledHalfWidth), top: sub(window.centerY, window.scaledHalfHeight), width: sum([window.scaledHalfWidth, 2]), height: sum([window.scaledHalfHeight, 2]), box: {left: window.translateX, top: window.translateY, width: window.width}}
      invariant(window.stepped !== null, 'stepped obstacles need the spring bank')
      const [centerXLane, centerYLane, widthLane, heightLane, scaleLane] = window.stepped as [Wire, Wire, Wire, Wire, Wire]
      const width = clamp(widthLane, zero, viewportWidth)
      const height = clamp(heightLane, zero, viewportHeight)
      const scale = clamp(scaleLane, zero, unit)
      const scaledHalfWidth = mul(half(width), scale)
      const scaledHalfHeight = mul(half(height), scale)
      const centerX = clamp(centerXLane, scaledHalfWidth, sub(viewportWidth, scaledHalfWidth))
      const centerY = clamp(centerYLane, scaledHalfHeight, sub(viewportHeight, scaledHalfHeight))
      return {left: sub(centerX, scaledHalfWidth), top: sub(centerY, scaledHalfHeight), width: sum([scaledHalfWidth, 2]), height: sum([scaledHalfHeight, 2]), box: {left: sub(centerX, half(width)), top: sub(centerY, half(height)), width}}
    }
    const order = current ? context.nextStack : context.stack
    const rankOf = (index: number) => sum(...order.map((row, rank) => [row[index]!, rank] as const))
    const notes = drawn(context.windows[notesWindowIndex]!)
    const contentLeft = sum(notes.box.left, [unit, 1])
    const contentTop = sum(notes.box.top, titleHeight, [unit, 1])
    const columnWidth = assume(min(relu(sum(notes.box.width, [unit, -2 - 2 * options.padding])), $.constant(options.maximumColumnWidth)), 0, options.maximumColumnWidth)
    const obstacles = obstacleIndices.map(index => {
      const window = context.windows[index]!
      const rectangle = drawn(window)
      const present = options.obstacles === 'destinations' ? window.visible : current ? window.opacity : window.present
      const above = kit.atLeast([[rankOf(index), 1], [rankOf(notesWindowIndex), -1]], 1)
      return {
        left: assume(sub(rectangle.left, contentLeft), ...localRange),
        top: assume(sub(rectangle.top, contentTop), ...localRange),
        width: assume(rectangle.width, 0, 16_384),
        height: assume(rectangle.height, 0, 16_384),
        active: kit.atLeast([[present, 1], [above, 1]], 2),
      }
    })
    return {obstacles, column: {left: $.constant(options.padding), width: columnWidth}}
  })

  const {slots, starts} = withSection(circuit, 'notes slots per obstacle subset', () => {
    const columnRight = sum(column.left, column.width)
    const intervals = obstacles.map(obstacle => ({left: sum(obstacle.left, [unit, -options.horizontalPadding]), right: sum(obstacle.left, obstacle.width, [unit, options.horizontalPadding])}))
    // Candidate slot starts: the column's left edge, and each interval's right edge.
    const starts = [column.left, ...intervals.map(interval => max(interval.right, column.left))]
    // Band-independent comparisons between candidate starts and interval edges.
    const inside = starts.map(start => intervals.map(interval => kit.atLeast([[greater([[start, 1], [interval.left, -1]]), 1], [greater([[interval.right, 1], [start, -1]]), 1]], 2)))
    const ends = starts.map(start => intervals.map(interval => select(atLeastZero([[interval.left, 1], [start, -1]]), columnRight, interval.left)))
    const slots = list(8, subset => {
      const members = obstacleIndices.map((_, index) => index).filter(index => (subset >> index & 1) === 1)
      const candidates = [0, ...members.map(index => index + 1)].map(candidate => {
        const covered = members.length === 0 ? zero : kit.atLeast(members.map(member => [inside[candidate]![member]!, 1] as const), 1)
        const end = min(columnRight, ...members.map(member => ends[candidate]![member]!))
        const width = relu(sub(end, starts[candidate]!))
        return {start: starts[candidate]!, width, fits: kit.atLeast([[atLeastZero([[width, 1], [unit, -options.minimumSlotWidth]]), 1], [covered, -1]], 1)}
      })
      // The widest slot that fits; ties go to the slot further right.
      let best = candidates[0]!
      for (const candidate of candidates.slice(1)) {
        const wider = greater([[candidate.width, 1], [best.width, -1]])
        const notNarrower = atLeastZero([[candidate.width, 1], [best.width, -1]])
        const righter = greater([[candidate.start, 1], [best.start, -1]])
        const equalAndRighter = kit.atLeast([[notNarrower, 1], [wider, -1], [righter, 1]], 2)
        const better = kit.atLeast([[kit.one, 1], [best.fits, -1], [wider, 1], [equalAndRighter, 1]], 1)
        const wins = kit.atLeast([[candidate.fits, 1], [better, 1]], 2)
        best = {start: select(wins, best.start, candidate.start), width: select(wins, best.width, candidate.width), fits: kit.atLeast([[best.fits, 1], [candidate.fits, 1]], 1)}
      }
      return {start: assume(best.start, ...localRange), width: assume(best.width, 0, options.maximumColumnWidth), fits: best.fits}
    })
    return {slots, starts}
  })

  const bands = withSection(circuit, 'notes band blocking', () => list(options.bands, band => {
    const bandTop = options.padding + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    // An obstacle blocks the band unless the band ends above it or starts below it (padded).
    const blocked = obstacles.map(obstacle => kit.atLeast([
      [obstacle.active, 1],
      [greater([[unit, bandBottom + options.verticalPadding], [obstacle.top, -1]]), 1],
      [greater([[obstacle.top, 1], [obstacle.height, 1], [unit, options.verticalPadding - bandTop]]), 1],
    ], 3))
    const subsetOneHot = list(8, subset => kit.atLeast(blocked.map((bit, index) => [bit, (subset >> index & 1) === 1 ? 1 : -1] as const), popcount(subset)))
    kit.declareOneHot(subsetOneHot, false)
    return {
      usable: assume(kit.dot(subsetOneHot, slots.map(slot => slot.fits)), 0, 1),
      left: kit.dot(subsetOneHot, slots.map(slot => slot.start)),
      width: kit.dot(subsetOneHot, slots.map(slot => slot.width)),
    }
  }))

  const {walk, geometry, fc} = withSection(circuit, 'notes line walker', () => {
    const fc = attachFastCircuit(circuit, unit, {startCursor: cells.startCursor, widthCells: cells.widths, breakAfterCells: cells.breakAfter}, options.epsilon, options.runLimit ?? longestBreakAfterRun(options.paragraph.breakAfter))
    const walk = walkGatheredLines(fc, options.window, bands.map(band => band.width), bands.map(band => band.usable))
    const geometry = segmentGeometry(fc, walk, bands.map(band => band.left), options.padding, options.lineHeight)
    return {walk, geometry, fc}
  })

  const words = textSegments(options.paragraph)
  const debug = {snap: [] as Wire[], active: [] as Wire[]}
  const {wordOutputs, animationActive} = withSection(circuit, 'notes word springs', () => {
    // Words snap before the first evaluation, while Notes is hidden, and while a word isn't laid out.
    const snapAll = kit.atLeast([[kit.one, 2], [cells.initialized, -1], [context.notesVisible, -1]], 1)
    const group: SpringGroup | null = context.group.kind === 'bank' ? createConstantPowerGroup(circuit, context.group.clock, options.springConstants, 'split-table') : null
    const activeTerms: Wire[] = []
    const wordOutputs = words.map((segment, index) => {
      const visible = geometry.visible[segment]!
      const snap = kit.atLeast([[snapAll, 1], [kit.one, 1], [visible, -1]], 1)
      const stored = cells.words[index]!
      const target = {x: geometry.x[segment]!, y: geometry.y[segment]!}
      let position: {x: Wire, y: Wire}
      if (context.group.kind === 'bank') {
        const destinations = cells.destinations[index]!
        const box = emitSpringBox(circuit, [
          {group: group!, position: stored.position.x, velocity: stored.velocity.x, destination: target.x, previousDestination: destinations.x},
          {group: group!, position: stored.position.y, velocity: stored.velocity.y, destination: target.y, previousDestination: destinations.y},
        ], {unit, settleDistance: context.group.settleDistance, settleSpeed: context.group.settleSpeed, retarget: 'deferred', snap})
        position = {x: box.positions[0]!, y: box.positions[1]!}
        table.next(stored, {position, velocity: {x: box.velocities[0]!, y: box.velocities[1]!}})
        table.next(destinations, {x: box.nextPreviousDestinations[0]!, y: box.nextPreviousDestinations[1]!})
        activeTerms.push(box.active)
        debug.snap.push(snap)
        debug.active.push(box.active)
      } else {
        const params = context.group.params
        const laneX = $.spring(stored.position.x, stored.velocity.x, target.x, params)
        const laneY = $.spring(stored.position.y, stored.velocity.y, target.y, params)
        position = {x: select(snap, laneX.position, target.x), y: select(snap, laneY.position, target.y)}
        table.next(stored, {position, velocity: {x: select(snap, laneX.velocity, zero), y: select(snap, laneY.velocity, zero)}})
        table.next(cells.destinations[index]!, cells.destinations[index]!)
        activeTerms.push(mul(not(snap), laneX.active), mul(not(snap), laneY.active))
      }
      return {...position, visible}
    })
    return {wordOutputs, animationActive: $.clamp01(sum(...activeTerms), 1)}
  })
  table.next(cells.initialized, unit)
  function not(wire: Wire) {
    return sub(unit, wire)
  }
  return {
    output: {words: wordOutputs, lineCount: walk.lineCount, windowOverflow: walk.windowOverflow, runOverflow: fc.runOverflow},
    debug: {
      ...debug,
      column,
      obstacles,
      bands: bands.map((band, index) => ({...band, start: walk.starts[index]!, lineWidth: walk.widths[index]!})),
      starts,
    },
    animationActive,
  }
}

function popcount(value: number) {
  let count = 0
  for (let bits = value; bits > 0; bits >>= 1) count += bits & 1
  return count
}
