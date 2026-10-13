// The Notes flow in HandwiredOS, checked against pretext's layoutNextLineRange
// (npm @chenglou/pretext) with a deterministic fake canvas: the circuit and the
// reference read widths from the same prepared text, so the reference's lines and
// segment positions are what the circuit must reproduce. The text is whatever the
// machine's notesText last wrote into the segment cells, e.g. every prefix of a
// sentence typed one character at a time.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {type PreparedTextWithSegments, layoutNextLineRange, prepareWithSegments} from '@chenglou/pretext'
import {Circuit, validateGrids, validateIndexReads, validateOneHotGroups} from '../../src/runtime/numeric-ui-core.ts'
// The fake canvas is installed before the first prepare call of this file.
import {testFont} from './fake-canvas.ts'
import {type FastParagraph, attachFastCircuit, fastWindow, maximumSegmentWidth, segmentGeometry, walkIndexedLines} from '../../src/handwiredos/notes-walker.ts'
import {
  type NotesOptions,
  defaultLineFitEpsilon,
  defaultNotesParagraph,
  lineFitEpsilonFor,
  notesCapacity,
  notesOptionsFor,
  notesText,
  notesWords,
} from '../../src/handwiredos/notes-paragraph.ts'
import {
  bandOutputField,
  createWindowManagerMachine,
  notesSourceField,
  notesWindowIndex,
  segmentOutputField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'

const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16
// pretext under bun: the navigator isn't Safari's, so its epsilon is 0.005.
const epsilon = defaultLineFitEpsilon
const notesOptions = notesOptionsFor(epsilon)

// A text as the fake canvas measures it: pretext's prepared text, which the pretext
// reference lays out, and every segment's width and break-after bit, which the
// machine's notesText writes into the segment cells, cut at the capacity. One cell
// per pretext segment, so the text must stay on pretext's fast path, e.g. letters,
// spaces and punctuation. notes-text.test.ts covers how the page turns other texts
// into cells.
type MeasuredText = {prepared: PreparedTextWithSegments, paragraph: FastParagraph}
function measure(text: string): MeasuredText {
  const prepared = prepareWithSegments(text, testFont)
  assert.ok(prepared.simpleLineWalkFastPath && prepared.letterSpacing === 0, 'the text is on pretext\'s fast path')
  return {prepared, paragraph: {widths: prepared.widths.map(width => Math.round(width * 64) / 64), breakAfter: prepared.kinds.map(kind => kind === 'space' || kind === 'zero-width-break' ? 1 : 0)}}
}
// The paragraph that Notes starts with.
const measured = measure(notesText)
// The segment index of each of its words, e.g. word 1 is segment 2, after the first space.
const wordSegments = defaultNotesParagraph.breakAfter.flatMap((breakAfter, segment) => breakAfter === 0 ? [segment] : [])

type Machine = ReturnType<typeof createWindowManagerMachine>
const frameTimeByMachine = new WeakMap<Machine, number>()

function step(machine: Machine, elapsed = frameDuration) {
  const frameTime = (frameTimeByMachine.get(machine) ?? 0) + elapsed
  frameTimeByMachine.set(machine, frameTime)
  return machine.step(viewportWidth, viewportHeight, frameTime)
}

function settle(machine: Machine) {
  for (let frames = 1; frames <= 240; frames++) {
    const values = step(machine)
    if (values[machine.output.animationActive] === 0) return values
  }
  assert.fail('spring animation did not settle')
}

// 8 ms before the next frame of step(), like window-manager.test.ts.
function pressTime(machine: Machine) {
  return (frameTimeByMachine.get(machine) ?? 0) + frameDuration - 8
}

type Segment = {x: number, y: number, visible: number}

// The outputs of the first `count` segment cells, i.e. the cells that hold the text.
function readSegments(machine: Machine, values: Float32Array, count: number): Segment[] {
  return Array.from({length: count}, (_, segment) => {
    const start = segment * segmentOutputField.size
    const read = (field: number) => values[machine.output.notes.segments[start + field]!]!
    return {x: read(segmentOutputField.x), y: read(segmentOutputField.y), visible: read(segmentOutputField.visible)}
  })
}

// The starting paragraph's words, in order.
function readWords(machine: Machine, values: Float32Array): Segment[] {
  const segments = readSegments(machine, values, defaultNotesParagraph.widths.length)
  return wordSegments.map(segment => segments[segment]!)
}

function readBands(machine: Machine, values: Float32Array) {
  return Array.from({length: notesOptions.bands}, (_, band) => {
    const start = band * bandOutputField.size
    const read = (field: number) => values[machine.output.notes.bands[start + field]!]!
    return {usable: read(bandOutputField.usable), left: read(bandOutputField.left), width: read(bandOutputField.width), start: read(bandOutputField.start)}
  })
}

type Rectangle = {left: number, top: number, width: number, height: number}

// Whether a laid-out segment's box, as wide as the segment and one line tall, overlaps
// a rectangle. Both are in the content box's coordinates.
function segmentOverlaps(segment: Segment, width: number, rectangle: Rectangle) {
  return segment.visible === 1
    && segment.x < rectangle.left + rectangle.width && segment.x + width > rectangle.left
    && segment.y < rectangle.top + rectangle.height && segment.y + notesOptions.lineHeight > rectangle.top
}

// The same for a word of the starting paragraph.
function wordOverlaps(word: Segment, wordIndex: number, rectangle: Rectangle) {
  return segmentOverlaps(word, measured.paragraph.widths[wordSegments[wordIndex]!]!, rectangle)
}

// The obstacles as the reference sees them, from a stored table: every window's
// destination rectangle (the maximized rectangle when maximized, the stored
// geometry otherwise) in the Notes content box's coordinates, active while the
// window is visible and stacked above Notes.
type Arrangement = {
  columnLeft: number
  columnWidth: number
  contentHeight: number
  obstacles: {left: number, top: number, width: number, height: number, active: boolean}[]
}

function arrangementOf(table: Float32Array): Arrangement {
  const width = table[sourceField.viewportWidth]!
  const height = table[sourceField.viewportHeight]!
  const titleHeight = table[sourceField.titleHeight]!
  const dockHeight = Math.min(table[sourceField.dockHeight]!, height)
  const dockTop = height - dockHeight
  const workspaceTop = Math.min(table[sourceField.systemBarHeight]!, dockTop)
  const workspaceHeight = dockTop - workspaceTop
  const maximumLeft = Math.min(table[sourceField.margin]!, width / 2)
  const maximumTopInset = Math.min(table[sourceField.margin]!, workspaceHeight / 2)
  const maximized = {left: maximumLeft, top: workspaceTop + maximumTopInset, width: Math.max(0, width - 2 * maximumLeft), height: Math.max(0, workspaceHeight - 2 * maximumTopInset)}
  const cell = (windowIndex: number, field: number) => table[windowSourceField(windowIndex, field)]!
  const destinationOf = (windowIndex: number) => cell(windowIndex, windowStateField.maximized) === 1
    ? maximized
    : {left: cell(windowIndex, windowStateField.left), top: cell(windowIndex, windowStateField.top), width: cell(windowIndex, windowStateField.width), height: cell(windowIndex, windowStateField.height)}
  const rankOf = (windowIndex: number) => Array.from({length: windowCount}, (_, rank) => rank).find(rank => table[stackSourceField(rank, windowIndex)] === 1)!
  const notes = destinationOf(notesWindowIndex)
  const contentLeft = notes.left + 1
  const contentTop = notes.top + titleHeight + 1
  const obstacles: Arrangement['obstacles'] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    if (windowIndex === notesWindowIndex) continue
    const destination = destinationOf(windowIndex)
    const visible = cell(windowIndex, windowStateField.open) === 1 && cell(windowIndex, windowStateField.minimized) === 0
    obstacles.push({
      left: destination.left - contentLeft,
      top: destination.top - contentTop,
      width: destination.width,
      height: destination.height,
      active: visible && rankOf(windowIndex) > rankOf(notesWindowIndex),
    })
  }
  return {
    columnLeft: notesOptions.padding,
    columnWidth: Math.min(notesOptions.maximumColumnWidth, Math.max(0, notes.width - 2 - 2 * notesOptions.padding)),
    contentHeight: Math.max(0, notes.height - titleHeight - 2),
    obstacles,
  }
}

// Each band's slot: dynamic-layout's column carving for several rectangles. Plain
// float64. A band is unusable when no slot is at least minimumSlotWidth wide, or
// when its bottom lies below the content box.
type Cursor = {segmentIndex: number, graphemeIndex: number}
type Interval = {left: number, right: number}
type Band = {top: number, usable: boolean, left: number, slotWidth: number, cutByHeight: boolean}

function carveBands(arrangement: Arrangement, options: NotesOptions): Band[] {
  return Array.from({length: options.bands}, (_, band) => {
    const top = options.padding + band * options.lineHeight
    const bottom = top + options.lineHeight
    const blocked: Interval[] = arrangement.obstacles
      .filter(obstacle => obstacle.active && !(bottom <= obstacle.top - options.verticalPadding || top >= obstacle.top + obstacle.height + options.verticalPadding))
      .map(obstacle => ({left: obstacle.left - options.horizontalPadding, right: obstacle.left + obstacle.width + options.horizontalPadding}))
    let slots: Interval[] = [{left: arrangement.columnLeft, right: arrangement.columnLeft + arrangement.columnWidth}]
    for (const interval of blocked) {
      const next: Interval[] = []
      for (const slot of slots) {
        if (interval.right <= slot.left || interval.left >= slot.right) {
          next.push(slot)
          continue
        }
        if (interval.left > slot.left) next.push({left: slot.left, right: interval.left})
        if (interval.right < slot.right) next.push({left: interval.right, right: slot.right})
      }
      slots = next
    }
    slots = slots.filter(slot => slot.right - slot.left >= options.minimumSlotWidth)
    const cutByHeight = slots.length > 0 && bottom > arrangement.contentHeight
    if (slots.length === 0 || cutByHeight) return {top, usable: false, left: 0, slotWidth: 0, cutByHeight}
    let slot = slots[0]!
    for (const candidate of slots.slice(1)) {
      const bestWidth = slot.right - slot.left
      const candidateWidth = candidate.right - candidate.left
      if (candidateWidth > bestWidth || (candidateWidth === bestWidth && candidate.left > slot.left)) slot = candidate
    }
    return {top, usable: true, left: slot.left, slotWidth: slot.right - slot.left, cutByHeight: false}
  })
}

// What the program must output for the segment cells that hold text: per band, the
// segment its line starts at, or null when the band holds no line of the text, and
// per segment, whether a band laid it out, and where.
type Flow = {
  bands: (Band & {lineStart: number | null})[]
  segments: {visible: boolean, x: number, y: number}[]
  lineCount: number
  truncated: number
}

// The pretext reference: layoutNextLineRange per usable band, over the whole text,
// reported for the `count` segments that the cells hold. A segment before the cut gets
// the line it gets in the whole text, since a line's breaks depend only on the
// segments up to the first one that doesn't fit. brokeInsideSegment is true when
// pretext broke a segment between two letters, which the program never does.
function pretextFlow(text: MeasuredText, count: number, arrangement: Arrangement, options: NotesOptions): Flow & {brokeInsideSegment: boolean} {
  const all = text.paragraph.widths.map(() => ({visible: false, x: 0, y: 0}))
  let brokeInsideSegment = false
  let cursor: Cursor = {segmentIndex: 0, graphemeIndex: 0}
  const bands = carveBands(arrangement, options).map(band => {
    if (!band.usable) return {...band, lineStart: null}
    const line = layoutNextLineRange(text.prepared, cursor, band.slotWidth)
    if (line === null) return {...band, lineStart: null}
    if (line.start.graphemeIndex !== 0 || line.end.graphemeIndex !== 0) brokeInsideSegment = true
    let x = band.left
    for (let segment = line.start.segmentIndex; segment < line.end.segmentIndex; segment++) {
      all[segment] = {visible: true, x, y: band.top}
      x += text.paragraph.widths[segment]!
    }
    cursor = line.end
    return {...band, lineStart: line.start.segmentIndex < count ? line.start.segmentIndex : null}
  })
  const segments = all.slice(0, count)
  return {
    bands,
    segments,
    lineCount: bands.filter(band => band.lineStart !== null).length,
    truncated: Number(count > 0 && !segments[count - 1]!.visible),
    brokeInsideSegment,
  }
}

// The walker's own rule in plain float64, over the segments that the cells hold. It
// is pretext's fast walker (see the tie test's referenceStarts below) with the
// program's two fixed limits: a line holds at most `window` segments, and a segment
// wider than its slot is laid out whole. So this reference also covers the texts
// where the program differs from pretext on purpose. windowOverflow counts the lines
// that wrapped at the window although the next segment fit.
function walkedFlow(cells: FastParagraph, arrangement: Arrangement, options: NotesOptions): Flow & {windowOverflow: number} {
  const count = cells.widths.length
  const segments = cells.widths.map(() => ({visible: false, x: 0, y: 0}))
  let start = 0
  let windowOverflow = 0
  const bands = carveBands(arrangement, options).map(band => {
    if (!band.usable || start >= count) return {...band, lineStart: null}
    const lineStart = start
    let span = cells.widths[start]!
    let end = start + 1
    const fits = (segment: number) => span + (cells.breakAfter[segment] === 1 ? 0 : cells.widths[segment]!) <= band.slotWidth + options.epsilon
    while (end < count && end - start < options.window && fits(end)) {
      span += cells.widths[end]!
      end++
    }
    if (end < count && end - start === options.window && fits(end)) windowOverflow++
    // A segment that breaks after itself and comes first after the line hangs at the line's end, like a space that fit.
    if (end < count && cells.breakAfter[end] === 1) end++
    let x = band.left
    for (let segment = start; segment < end; segment++) {
      segments[segment] = {visible: true, x, y: band.top}
      x += cells.widths[segment]!
    }
    start = end
    return {...band, lineStart}
  })
  return {bands, segments, lineCount: bands.filter(band => band.lineStart !== null).length, truncated: Number(start < count), windowOverflow}
}

// The ways the Notes outputs in `values` differ from a flow.
function flowProblems(machine: Machine, values: Float32Array, expected: Flow) {
  const problems: string[] = []
  readBands(machine, values).forEach((band, index) => {
    const expectedBand = expected.bands[index]!
    if (band.usable !== Number(expectedBand.usable)) problems.push(`band ${index} usable ${band.usable}, expected ${Number(expectedBand.usable)}`)
    else if (expectedBand.usable && (band.left !== expectedBand.left || band.width !== expectedBand.slotWidth)) problems.push(`band ${index} slot ${band.left},${band.width}, expected ${expectedBand.left},${expectedBand.slotWidth}`)
    // A usable band after the text's last line starts at or after the count of cells that hold text.
    else if (expectedBand.usable && expectedBand.lineStart === null && band.start < expected.segments.length) problems.push(`band ${index} starts at ${band.start}, inside the text`)
    else if (expectedBand.lineStart !== null && band.start !== expectedBand.lineStart) problems.push(`band ${index} starts at ${band.start}, expected ${expectedBand.lineStart}`)
  })
  readSegments(machine, values, expected.segments.length).forEach((segment, index) => {
    const expectedSegment = expected.segments[index]!
    if (segment.visible !== Number(expectedSegment.visible)) problems.push(`segment ${index} visible ${segment.visible}, expected ${Number(expectedSegment.visible)}`)
    else if (expectedSegment.visible && (segment.x !== Math.fround(expectedSegment.x) || segment.y !== expectedSegment.y)) problems.push(`segment ${index} at ${segment.x},${segment.y}, expected ${expectedSegment.x},${expectedSegment.y}`)
  })
  const lineCount = values[machine.output.notes.lineCount]!
  if (lineCount !== expected.lineCount) problems.push(`line count ${lineCount}, expected ${expected.lineCount}`)
  const truncated = values[machine.output.notes.truncated]!
  if (truncated !== expected.truncated) problems.push(`truncated ${truncated}, expected ${expected.truncated}`)
  return problems
}

// Compares the Notes outputs in `values` with both references, for the arrangement
// and the segment cells that `table` holds and the text that was written into those
// cells. The walker's rule must hold for every text. pretext must agree whenever the
// text stays within the program's limits, i.e. no line reaches past the window and
// pretext broke no segment between two letters.
function compareWithReferences(machine: Machine, values: Float32Array, table: Float32Array, text: MeasuredText) {
  const arrangement = arrangementOf(table)
  const count = Math.min(notesCapacity, text.paragraph.widths.length)
  const cells: FastParagraph = {widths: text.paragraph.widths.slice(0, count), breakAfter: text.paragraph.breakAfter.slice(0, count)}
  const problems: string[] = []
  if (table[notesSourceField.arrivedCount] !== count) problems.push(`the cells hold ${table[notesSourceField.arrivedCount]} segments, expected ${count}`)
  for (let segment = 0; segment < notesCapacity; segment++) {
    const width = table[notesSourceField.widthStart + segment]
    const breakAfter = table[notesSourceField.breakAfterStart + segment]
    if (width !== (cells.widths[segment] ?? 0) || breakAfter !== (cells.breakAfter[segment] ?? 0)) problems.push(`cell ${segment} holds ${width},${breakAfter}, expected ${cells.widths[segment] ?? 0},${cells.breakAfter[segment] ?? 0}`)
  }
  const walked = walkedFlow(cells, arrangement, notesOptions)
  problems.push(...flowProblems(machine, values, walked))
  const windowOverflow = values[machine.output.notes.windowOverflow]!
  if (windowOverflow !== walked.windowOverflow) problems.push(`window overflow ${windowOverflow}, expected ${walked.windowOverflow}`)
  const pretext = pretextFlow(text, count, arrangement, notesOptions)
  const matchesPretext = !pretext.brokeInsideSegment && walked.windowOverflow === 0
  if (matchesPretext) problems.push(...flowProblems(machine, values, pretext).map(problem => `against pretext: ${problem}`))
  const segments = readSegments(machine, values, count)
  const windowsAbove = arrangement.obstacles.filter(obstacle => obstacle.active)
  // Laid-out words on a line that is level with part of a window stacked above
  // Notes, i.e. the words that the overlap check could catch. A word wider than its
  // band's slot reaches past the slot, so the check leaves such a word out.
  let wordsBesideWindowsAbove = 0
  segments.forEach((segment, index) => {
    if (cells.breakAfter[index] === 1 || segment.visible === 0) return
    const band = walked.bands[Math.round((segment.y - notesOptions.padding) / notesOptions.lineHeight)]!
    if (cells.widths[index]! > band.slotWidth) return
    if (windowsAbove.some(window => segment.y < window.top + window.height && segment.y + notesOptions.lineHeight > window.top)) wordsBesideWindowsAbove++
    for (const window of windowsAbove) {
      if (segmentOverlaps(segment, cells.widths[index]!, window)) problems.push(`segment ${index} at ${segment.x},${segment.y} overlaps the window above Notes at ${window.left},${window.top}`)
    }
  })
  return {problems, arrangement, walked, pretext, matchesPretext, values, segments, wordsBesideWindowsAbove}
}

// Evaluates the machine's program on a table that holds the starting paragraph, and
// compares the Notes outputs with both references for that table's arrangement.
function compareWithReference(machine: Machine, table: Float32Array) {
  const values = machine.circuit.evaluateTensor(table)
  const comparison = compareWithReferences(machine, values, table, measured)
  return {...comparison, reference: comparison.pretext, words: wordSegments.map(segment => comparison.segments[segment]!)}
}

// Checks the program's declarations on the table of every evaluation: every declared
// and inferred grid; every declared one-hot group, e.g. each band's one-hot of the
// windows that block it; and every index read's index, which must be a whole number
// within its declared range, e.g. the segment that a band's line starts at. The
// values come from the compiled program, which leaves the wires it removed at 0, and
// every group's members are live there, since the gather reads read them.
function checkDeclarationsOnEveryEvaluation(machine: Machine) {
  const counts = {evaluations: 0}
  machine.observe({
    beforeEvaluate(table) {
      const values = machine.circuit.evaluateTensor(table)
      validateGrids(machine.circuit, values)
      validateOneHotGroups(machine.circuit, values)
      validateIndexReads(machine.circuit, values)
      counts.evaluations++
    },
  })
  return counts
}

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, minimum: number, maximum: number) {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}

// A stored table with random window geometry, stacking and minimized bits, as the
// machine would hold it at rest.
function writeArrangement(table: Float32Array, random: () => number) {
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const width = randomInteger(random, 280, 700)
    const height = randomInteger(random, 190, 520)
    table[windowSourceField(windowIndex, windowStateField.width)] = width
    table[windowSourceField(windowIndex, windowStateField.height)] = height
    table[windowSourceField(windowIndex, windowStateField.left)] = randomInteger(random, 0, viewportWidth - width)
    table[windowSourceField(windowIndex, windowStateField.top)] = randomInteger(random, 36, 724 - height)
    table[windowSourceField(windowIndex, windowStateField.minimized)] = windowIndex !== notesWindowIndex && random() < 0.15 ? 1 : 0
    table[windowSourceField(windowIndex, windowStateField.maximized)] = 0
  }
  // A Fisher-Yates shuffle, which draws 3 random values. Sorting with a random comparator, as this function did
  // before, draws as many values as the engine's sort makes comparisons, and Bun's sort makes other comparisons once
  // the calling loop is optimized, so one seed gave different arrangements in different runs of the same test.
  const order = Array.from({length: windowCount}, (_, index) => index)
  for (let index = windowCount - 1; index > 0; index--) {
    const other = randomInteger(random, 0, index)
    const moved = order[index]!
    order[index] = order[other]!
    order[other] = moved
  }
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      table[stackSourceField(rank, windowIndex)] = order[rank] === windowIndex ? 1 : 0
    }
  }
}

test('the fake canvas measurement reproduces the baked default paragraph, and the epsilon rule follows pretext', () => {
  assert.deepEqual(measured.paragraph, defaultNotesParagraph)
  assert.equal(measured.prepared.segments.length, 89)
  assert.equal(notesWords.length, 45)
  assert.deepEqual(measured.prepared.segments.filter((_, index) => defaultNotesParagraph.breakAfter[index] === 0), notesWords)
  assert.deepEqual([notesOptions.capacity, notesOptions.window, notesOptions.runLimit, notesOptions.minimumSlotWidth], [256, 64, 1, 80])
  // The starting paragraph's longest line in the widest column holds 25 segments, so fastWindow asks for 26 comparisons.
  assert.equal(fastWindow(defaultNotesParagraph, notesOptions.maximumColumnWidth, epsilon), 26)
  // The fake widths lie on the 1/64 px grid, so the reference and the circuit see the same numbers.
  assert.ok(measured.prepared.widths.every(width => Number.isInteger(width * 64)))
  assert.equal(lineFitEpsilonFor(navigator), epsilon)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15', vendor: 'Apple Computer, Inc.'}), 1 / 64)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36', vendor: 'Google Inc.'}), 0.005)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0', vendor: ''}), 0.005)
})

// The cells that hold the Notes text in a table: the widths and break-after bits of the first cells, and the count.
function readTextCells(table: Float32Array, cells: number) {
  return {
    widths: Array.from({length: cells}, (_, segment) => table[notesSourceField.widthStart + segment]!),
    breakAfter: Array.from({length: cells}, (_, segment) => table[notesSourceField.breakAfterStart + segment]!),
    arrivedCount: table[notesSourceField.arrivedCount]!,
  }
}

test('a machine starts with any paragraph, and a text is rounded, clamped and cut to what the cells hold', () => {
  const machine = createWindowManagerMachine({notes: {paragraph: {widths: [10, 4, 10], breakAfter: [0, 1, 0]}, epsilon}})
  assert.deepEqual(readTextCells(machine.source, 4), {widths: [10, 4, 10, 0], breakAfter: [0, 1, 0, 0], arrivedCount: 3})
  const values = step(machine)
  assert.deepEqual(readSegments(machine, values, 3).map(segment => segment.visible), [1, 1, 1])
  // A width off the 1/64 px grid, a width that isn't a number, a width above the cells' range, a negative width, and
  // break-after values that aren't bits. The table check passes, since notesText fits the paragraph to the cells first.
  assert.equal(machine.notesText({widths: [30.4, Number.NaN, 3000, -5, Number.POSITIVE_INFINITY], breakAfter: [0, 2, 0.5, 1, -1]}), 5)
  step(machine)
  assert.deepEqual(readTextCells(machine.source, 6), {widths: [30.40625, 0, maximumSegmentWidth, 0, 0, 0], breakAfter: [0, 0, 0, 1, 0, 0], arrivedCount: 5})
  // More segments than cells: the cells hold as many as there are cells, from the first on.
  const long: FastParagraph = {widths: Array.from({length: 300}, (_, segment) => segment % 2 === 0 ? 20 : 4), breakAfter: Array.from({length: 300}, (_, segment) => segment % 2)}
  assert.equal(machine.notesText(long), notesCapacity)
  step(machine)
  const cells = readTextCells(machine.source, notesCapacity)
  assert.equal(cells.arrivedCount, notesCapacity)
  assert.deepEqual(cells.widths, long.widths.slice(0, notesCapacity))
  assert.deepEqual(cells.breakAfter, long.breakAfter.slice(0, notesCapacity))
  const cut = createWindowManagerMachine({notes: {paragraph: long, epsilon}})
  assert.equal(readTextCells(cut.source, 1).arrivedCount, notesCapacity)
  assert.throws(() => machine.notesText({widths: [10, 4], breakAfter: [0]}), /one break-after bit per segment/)
})

test('flows around random window arrangements match pretext line for line and word for word', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  const random = createRandom(11)
  let checkedWords = 0
  let blockedBands = 0
  let bandsWithTwoSlots = 0
  let bandsCutByHeight = 0
  let truncatedArrangements = 0
  let wordsBesideWindows = 0
  const failures: unknown[] = []
  for (let trial = 0; trial < 60; trial++) {
    const table = Float32Array.from(machine.source)
    writeArrangement(table, random)
    const {problems, reference, arrangement, wordsBesideWindowsAbove, matchesPretext} = compareWithReference(machine, table)
    assert.ok(matchesPretext, 'the starting paragraph stays within the program\'s limits')
    checkedWords += reference.segments.filter(segment => segment.visible).length
    wordsBesideWindows += wordsBesideWindowsAbove
    blockedBands += reference.bands.filter(band => !band.usable || band.slotWidth < arrangement.columnWidth).length
    bandsCutByHeight += reference.bands.filter(band => band.cutByHeight).length
    if (!reference.segments.at(-1)!.visible) truncatedArrangements++
    for (let band = 0; band < notesOptions.bands; band++) {
      const top = notesOptions.padding + band * notesOptions.lineHeight
      const blocking = arrangement.obstacles.filter(obstacle => obstacle.active && !(top + notesOptions.lineHeight <= obstacle.top - 4 || top >= obstacle.top + obstacle.height + 4))
      if (blocking.length >= 2) bandsWithTwoSlots++
    }
    if (problems.length > 0) failures.push({trial, problems: problems.slice(0, 4)})
  }
  assert.deepEqual(failures, [])
  assert.ok(checkedWords > 600, `${checkedWords} words checked`)
  assert.ok(blockedBands > 60, `${blockedBands} blocked bands`)
  assert.ok(bandsWithTwoSlots > 0)
  // compareWithReference also checks that no laid-out word overlaps a window stacked
  // above Notes; this many words were on a line level with such a window.
  assert.ok(wordsBesideWindows > 500, `${wordsBesideWindows} words beside a window above Notes`)
  assert.ok(bandsCutByHeight > 0, 'some band was cut by the content height')
  assert.ok(truncatedArrangements > 0 && truncatedArrangements < 60, `${truncatedArrangements} arrangements truncated`)
})

test('words move straight to the new layout in the frame of the event, while the windows still animate', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  const before = readWords(machine, settle(machine))
  // Photos (650,190 560×430) starts stacked above Notes; its minimize button is centered at 1135,212.
  const time = pressTime(machine)
  machine.pointerDown(1135, 212, time)
  machine.pointerUp(1135, 212, time)
  // A copy, since the settle below overwrites the machine's values, and the line
  // count at the end reads the frame of the press.
  const values = step(machine).slice()
  assert.equal(machine.source[windowSourceField(2, windowStateField.minimized)], 1)
  assert.equal(values[machine.output.animationActive], 1)
  const during = readWords(machine, values)
  assert.notDeepEqual(during, before)
  // In the frame of the press, the text already fills Photos' area, while Photos is
  // still drawn there at nearly full size on its way to the dock: the flow reads
  // which windows are visible after the event, not the drawn frames.
  const photosOutput = (field: number) => values[machine.output.windows[2 * windowOutputField.size + field]!]!
  assert.equal(photosOutput(windowOutputField.opacity), 1)
  assert.ok(photosOutput(windowOutputField.scale) > 0.9, `Photos drawn at scale ${photosOutput(windowOutputField.scale)}`)
  // The obstacles are Files and Photos, in window order.
  const photosArea = arrangementOf(machine.source).obstacles[1]!
  assert.equal(photosArea.active, false)
  assert.ok(during.some((word, wordIndex) => wordOverlaps(word, wordIndex, photosArea)), 'some word is laid out in Photos\' area')
  // The words don't move again while Photos flies to the dock.
  const settled = settle(machine)
  assert.deepEqual(readWords(machine, settled), during)
  assert.deepEqual(compareWithReference(machine, machine.source).problems, [])
  // With Photos gone, no window is above Notes, and the paragraph fits in 5 lines
  // of the whole column.
  assert.equal(values[machine.output.notes.lineCount], 5)
  assert.ok(during.every(word => word.visible === 1))
})

test('dragging Files over Notes reflows the paragraph, and the settled words match pretext', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  const before = readWords(machine, settle(machine)).map(word => word.y)
  // Files' title bar at 100,70; drag it right by 400 and down by 100, over the Notes window.
  let time = pressTime(machine)
  machine.pointerDown(100, 70, time)
  machine.pointerMove(300, 120, time += 4)
  machine.pointerMove(500, 170, time += 4)
  machine.pointerUp(500, 170, time += 4)
  step(machine)
  settle(machine)
  const {problems, arrangement, words} = compareWithReference(machine, machine.source)
  assert.deepEqual(problems, [])
  assert.equal(arrangement.obstacles[0]!.active, true)
  assert.notDeepEqual(words.map(word => word.y), before)
})

test('a band below the content box is unusable, so no word is placed where the window would clip it', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  settle(machine)
  // Raise Notes above Photos, then drag Files (540×340) to 380,60: it covers the
  // whole column of the default Notes window (content box 498×320) down to band 10,
  // the paragraph continues in bands 11 and 12, and bands 13 to 15 end below the
  // 320 px content box.
  let time = pressTime(machine)
  machine.pointerDown(450, 126, time)
  machine.pointerUp(450, 126, time)
  step(machine)
  time = pressTime(machine)
  machine.pointerDown(100, 70, time)
  machine.pointerMove(426, 76, time += 4)
  machine.pointerUp(426, 76, time += 4)
  step(machine)
  const settled = settle(machine)
  assert.equal(machine.source[windowSourceField(0, windowStateField.left)], 380)
  const contentHeight = settled[machine.output.windows[notesWindowIndex * windowOutputField.size + windowOutputField.contentHeight]!]!
  assert.equal(contentHeight, 320)
  const {problems, reference, values, words, arrangement} = compareWithReference(machine, machine.source)
  assert.deepEqual(problems, [])
  assert.deepEqual(reference.bands.map(band => band.cutByHeight), Array.from({length: 16}, (_, band) => band >= 13))
  assert.deepEqual(readBands(machine, values).map(band => band.usable), Array.from({length: 16}, (_, band) => Number(band === 11 || band === 12)))
  const visibleWords = words.filter(word => word.visible === 1)
  assert.ok(visibleWords.length > 0 && visibleWords.length < notesWords.length, `${visibleWords.length} visible words`)
  assert.ok(visibleWords.every(word => word.y + notesOptions.lineHeight <= contentHeight))
  assert.ok(visibleWords.every(word => word.y >= notesOptions.padding + 11 * notesOptions.lineHeight))
  assert.equal(values[machine.output.notes.truncated], 1)
  assert.equal(values[machine.output.notes.lineCount], 2)
  // The gate hides words: without it, the reference lays out more of the paragraph
  // in bands below the content box.
  const ungated = pretextFlow(measured, measured.paragraph.widths.length, {...arrangement, contentHeight: Infinity}, notesOptions)
  const hiddenByGate = wordSegments.filter(segment => ungated.segments[segment]!.visible && !reference.segments[segment]!.visible)
  assert.ok(hiddenByGate.length > 0, 'some word is hidden only by the content height')
  assert.ok(hiddenByGate.every(segment => ungated.segments[segment]!.y + notesOptions.lineHeight > contentHeight))
})

test('a paragraph that needs more lines than the flow has bands stays finite, with the trailing words invisible', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  const table = Float32Array.from(machine.source)
  // Notes at the left edge, and Files above it covering the column except an 85 px
  // slot at the right, so every band holds one or two words.
  const write = (windowIndex: number, geometry: [left: number, top: number, width: number, height: number]) => {
    const [left, top, width, height] = geometry
    table[windowSourceField(windowIndex, windowStateField.left)] = left
    table[windowSourceField(windowIndex, windowStateField.top)] = top
    table[windowSourceField(windowIndex, windowStateField.width)] = width
    table[windowSourceField(windowIndex, windowStateField.height)] = height
  }
  write(notesWindowIndex, [0, 36, 500, 500])
  write(0, [0, 36, 370, 500])
  table[windowSourceField(2, windowStateField.minimized)] = 1
  const order = [2, 1, 0]
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      table[stackSourceField(rank, windowIndex)] = order[rank] === windowIndex ? 1 : 0
    }
  }
  const {problems, values, words, reference} = compareWithReference(machine, table)
  assert.deepEqual(problems, [])
  const notesWires = [
    ...machine.output.notes.segments,
    ...machine.output.notes.bands,
    machine.output.notes.lineCount,
    machine.output.notes.truncated,
    machine.output.notes.windowOverflow,
    machine.output.notes.runOverflow,
  ]
  assert.ok(notesWires.every(wire => Number.isFinite(values[wire])), 'every Notes output is finite')
  assert.deepEqual([values[machine.output.notes.windowOverflow], values[machine.output.notes.runOverflow]], [0, 0])
  assert.ok(reference.bands.every(band => band.usable && band.slotWidth === 85))
  assert.equal(values[machine.output.notes.lineCount], 16)
  assert.equal(values[machine.output.notes.truncated], 1)
  const visibleWords = words.filter(word => word.visible === 1).length
  assert.ok(visibleWords >= 16 && visibleWords < notesWords.length, `${visibleWords} visible words`)
  // Every laid-out word is inside its band's slot, and the invisible words come last.
  assert.ok(words.every(word => word.visible === 0 || (word.x >= 379 && word.x < 464)))
  assert.deepEqual(words.map(word => word.visible), words.map((_, index) => Number(index < visibleWords)))
})

// A machine at rest in the starting arrangement, where Photos covers the right of the
// Notes column.
function machineAtStart() {
  const machine = createWindowManagerMachine()
  step(machine)
  return machine
}

// A machine with Notes raised above the other windows by a press on its title bar, so
// the column is 440 px wide and nothing covers it.
function machineWithNotesInFront() {
  const machine = machineAtStart()
  const time = pressTime(machine)
  machine.pointerDown(450, 126, time)
  machine.pointerUp(450, 126, time)
  step(machine)
  settle(machine)
  return machine
}

// A machine with Notes raised, then Files dragged over it to 380,60, which leaves
// the two bands below Files, see the test of the band below the content box.
function machineWithFilesOverNotes() {
  const machine = machineWithNotesInFront()
  let time = pressTime(machine)
  machine.pointerDown(100, 70, time)
  machine.pointerMove(426, 76, time += 4)
  machine.pointerUp(426, 76, time += 4)
  step(machine)
  settle(machine)
  return machine
}

// Writes a text into Notes with the machine's notesText, as an event 8 ms before the
// next frame, runs that frame, and compares the frame's outputs with both references.
function typeAndCompare(machine: Machine, text: MeasuredText) {
  const cellsWithText = machine.notesText(text.paragraph, pressTime(machine))
  assert.equal(cellsWithText, Math.min(notesCapacity, text.paragraph.widths.length))
  const values = step(machine)
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [['events', ['notes text']], ['frame', []]])
  return compareWithReferences(machine, values, machine.source, text)
}

// The same text around a random arrangement of the windows: the machine's program on a
// copy of its stored table.
function compareAroundRandomWindows(machine: Machine, text: MeasuredText, random: () => number) {
  const table = Float32Array.from(machine.source)
  writeArrangement(table, random)
  return compareWithReferences(machine, machine.circuit.evaluateTensor(table), table, text)
}

type Comparison = ReturnType<typeof compareWithReferences>

// Counts over the states of one test, so that the test can say what it covered. A state is either compared with
// pretext, or it has a line past the walker's window, or pretext broke a word in it between two letters.
function createTally() {
  const tally = {states: 0, statesMatchingPretext: 0, statesPastWindow: 0, statesWherePretextBrokeWords: 0, truncatedStates: 0, cutAtCapacity: 0, mostLines: 0, checkedSegments: 0, failures: [] as unknown[]}
  return {
    tally,
    add: (label: string, text: MeasuredText, comparison: Comparison) => {
      tally.states++
      if (comparison.matchesPretext) tally.statesMatchingPretext++
      else if (comparison.pretext.brokeInsideSegment) tally.statesWherePretextBrokeWords++
      else tally.statesPastWindow++
      if (comparison.walked.truncated === 1) tally.truncatedStates++
      if (text.paragraph.widths.length > notesCapacity) tally.cutAtCapacity++
      tally.mostLines = Math.max(tally.mostLines, comparison.walked.lineCount)
      tally.checkedSegments += comparison.segments.length
      if (comparison.problems.length > 0 && tally.failures.length < 5) tally.failures.push({label, problems: comparison.problems.slice(0, 4)})
    },
  }
}

// Words of at most 7 letters, so each fits the narrowest slot, 80 px, and pretext never breaks one between two
// letters. The words of one and two letters put the most segments on a line: in 3,000 random texts of these words,
// a 440 px line held at most 47 segments, fewer than the walker's window of 64. So the random texts below stay
// within the program's limits, and pretext is the reference in every state. The test of a line with more segments
// than the window covers the other case.
const vocabulary = 'the quick brown fox jumps over a lazy dog and then it naps under an old oak tree while rain taps on every window of our small quiet house near wide green fields I am so on to we be at by is as of in up no go do my me he if or us ox'.split(' ')

function randomText(random: () => number, wordCount: number) {
  const words: string[] = []
  for (let index = 0; index < wordCount; index++) {
    const word = vocabulary[randomInteger(random, 0, vocabulary.length - 1)]!
    words.push(random() < 0.12 ? `${word}${random() < 0.5 ? ',' : '.'}` : word)
  }
  return words.join(' ')
}

const typedSentence =
  'Hello there. This is a note that I am typing into the same circuit that runs the windows, one key at a time, '
  + 'and every key is one new table of widths. It wraps at the right edge, and words move to the next line when they '
  + 'stop fitting, and they come back when I delete.'

test('typing a sentence one character at a time, then deleting it, lays out every prefix where pretext does', () => {
  const whole = measure(typedSentence).paragraph
  assert.ok(whole.widths.length <= notesCapacity, 'the sentence fits the cells')
  assert.ok(fastWindow(whole, notesOptions.maximumColumnWidth, epsilon) <= notesOptions.window, 'no line of the sentence reaches past the window')
  const machines = {
    'Notes in front': machineWithNotesInFront(),
    'starting arrangement': machineAtStart(),
    'Files over Notes': machineWithFilesOverNotes(),
  }
  const declarationChecks = Object.values(machines).map(checkDeclarationsOnEveryEvaluation)
  const random = createRandom(5)
  const {tally, add} = createTally()
  let mostCellsChangedByOneKey = 0
  let previous: FastParagraph = {widths: [], breakAfter: []}
  // Every prefix while typing, then every third prefix while deleting.
  const lengths = [
    ...Array.from({length: typedSentence.length + 1}, (_, length) => length),
    ...Array.from({length: Math.floor(typedSentence.length / 3) + 1}, (_, index) => typedSentence.length - 3 * index),
  ]
  lengths.forEach((length, index) => {
    const text = measure(typedSentence.slice(0, length))
    // While typing, after the first character: how many cells this key changed.
    if (index >= 2 && index <= typedSentence.length) {
      let changed = 0
      for (let segment = 0; segment < Math.max(text.paragraph.widths.length, previous.widths.length); segment++) {
        if ((text.paragraph.widths[segment] ?? 0) !== (previous.widths[segment] ?? 0)) changed++
        if ((text.paragraph.breakAfter[segment] ?? 0) !== (previous.breakAfter[segment] ?? 0)) changed++
      }
      mostCellsChangedByOneKey = Math.max(mostCellsChangedByOneKey, changed)
    }
    previous = text.paragraph
    for (const [label, machine] of Object.entries(machines)) add(`${label}, ${length} characters`, text, typeAndCompare(machine, text))
    add(`random windows, ${length} characters`, text, compareAroundRandomWindows(machines['Notes in front'], text, random))
  })
  assert.deepEqual(tally.failures, [])
  assert.equal(tally.states, 4 * lengths.length)
  // The sentence stays within the program's limits in every state, so pretext is the reference in every state.
  assert.equal(tally.statesMatchingPretext, tally.states)
  assert.ok(tally.truncatedStates > 200 && tally.truncatedStates < tally.states, `${tally.truncatedStates} truncated states`)
  assert.ok(tally.mostLines >= 12, `${tally.mostLines} lines at most`)
  assert.ok(tally.checkedSegments > 80_000, `${tally.checkedSegments} segments checked`)
  // A key at the end of the text changes the last word's width cell, or adds a space's two cells and a word's width cell.
  assert.equal(mostCellsChangedByOneKey, 3)
  for (const checks of declarationChecks) assert.equal(checks.evaluations, 2 * lengths.length)
}, 60_000)

// The most words whose segments, i.e. the words and the spaces between them, fit the cells.
const mostWordsInCells = notesCapacity / 2

test('random texts of every length that fits the cells match pretext, through the machine and around random window arrangements', () => {
  const machines = {'Notes in front': machineWithNotesInFront(), 'starting arrangement': machineAtStart()}
  const declarationChecks = Object.values(machines).map(checkDeclarationsOnEveryEvaluation)
  const random = createRandom(13)
  const {tally, add} = createTally()
  const wordCounts = new Set<number>()
  for (let trial = 0; trial < 300; trial++) {
    const wordCount = trial < 3 ? [0, 1, mostWordsInCells][trial]! : randomInteger(random, 0, mostWordsInCells)
    wordCounts.add(wordCount)
    const text = measure(randomText(random, wordCount))
    for (const [label, machine] of Object.entries(machines)) add(`${label}, trial ${trial}`, text, typeAndCompare(machine, text))
    add(`random windows, trial ${trial}`, text, compareAroundRandomWindows(machines['Notes in front'], text, random))
  }
  assert.deepEqual(tally.failures, [])
  assert.deepEqual([tally.states, tally.statesMatchingPretext, tally.cutAtCapacity], [900, 900, 0])
  assert.ok(wordCounts.size > 0.8 * mostWordsInCells, `${wordCounts.size} different word counts`)
  assert.ok(tally.truncatedStates > 100, `${tally.truncatedStates} truncated states`)
  for (const checks of declarationChecks) assert.equal(checks.evaluations, 600)
}, 60_000)

test('inserting and deleting words in the middle of a text matches pretext after every edit', () => {
  const machines = {'Notes in front': machineWithNotesInFront(), 'starting arrangement': machineAtStart()}
  const random = createRandom(19)
  const {tally, add} = createTally()
  const words = randomText(random, 40).split(' ')
  let insertions = 0
  let deletions = 0
  for (let edit = 0; edit < 300; edit++) {
    const position = randomInteger(random, 0, words.length)
    if (words.length >= mostWordsInCells || (words.length > 5 && random() < 0.45)) {
      words.splice(Math.min(position, words.length - 1), 1)
      deletions++
    } else {
      words.splice(position, 0, vocabulary[randomInteger(random, 0, vocabulary.length - 1)]!)
      insertions++
    }
    const text = measure(words.join(' '))
    for (const [label, machine] of Object.entries(machines)) add(`${label}, edit ${edit}`, text, typeAndCompare(machine, text))
    add(`random windows, edit ${edit}`, text, compareAroundRandomWindows(machines['Notes in front'], text, random))
  }
  assert.deepEqual(tally.failures, [])
  assert.deepEqual([tally.states, tally.statesMatchingPretext, tally.cutAtCapacity], [900, 900, 0])
  assert.ok(insertions > 100 && deletions > 100, `${insertions} insertions and ${deletions} deletions`)
}, 60_000)

test('a text with more segments than the cells is cut at the capacity, and the segments before the cut get pretext\'s lines', () => {
  const machines = {'Notes in front': machineWithNotesInFront(), 'starting arrangement': machineAtStart()}
  const random = createRandom(29)
  const {tally, add} = createTally()
  for (let trial = 0; trial < 60; trial++) {
    const text = measure(randomText(random, randomInteger(random, mostWordsInCells + 1, 2 * mostWordsInCells)))
    for (const [label, machine] of Object.entries(machines)) {
      const comparison = typeAndCompare(machine, text)
      add(`${label}, trial ${trial}`, text, comparison)
      assert.equal(comparison.segments.length, notesCapacity)
    }
    add(`random windows, trial ${trial}`, text, compareAroundRandomWindows(machines['Notes in front'], text, random))
  }
  assert.deepEqual(tally.failures, [])
  assert.deepEqual([tally.states, tally.statesMatchingPretext, tally.cutAtCapacity], [180, 180, 180])
  // With Notes in front, the segments that the cells hold fit the bands, so `truncated` is 0 although the text was
  // cut: the program only knows the cells. Whether the text was cut is the host's to know, from notesText's result.
  const inFront = machines['Notes in front']
  const text = measure(randomText(random, notesCapacity))
  assert.equal(text.paragraph.widths.length, 2 * notesCapacity - 1)
  const comparison = typeAndCompare(inFront, text)
  assert.deepEqual(comparison.problems, [])
  assert.equal(comparison.values[inFront.output.notes.truncated], 0)
  assert.ok(comparison.segments.every(segment => segment.visible === 1))
}, 60_000)

test('a line with more segments than the window wraps at the window, and windowOverflow counts such lines', () => {
  const machine = machineWithNotesInFront()
  checkDeclarationsOnEveryEvaluation(machine)
  const {window} = notesOptions
  // One-letter words are 6.34 px wide and a space 4.375 px, so the 440 px column fits 41 words and the 41 spaces
  // after them, 82 segments, more than the window. 10 more words than the window holds segments make 2 * window + 19
  // segments: pretext lays them out in lines of 82 segments, and the program in two lines of `window` segments and
  // a third with the other 19.
  const text = measure(Array.from({length: window + 10}, () => 'i').join(' '))
  assert.equal(text.paragraph.widths.length, 2 * window + 19)
  assert.ok(window < 82 && 2 * window + 19 <= notesCapacity)
  const comparison = typeAndCompare(machine, text)
  assert.deepEqual(comparison.problems, [])
  assert.equal(comparison.matchesPretext, false)
  assert.deepEqual(comparison.pretext.bands.slice(0, 2).map(band => band.lineStart), [0, 82])
  assert.deepEqual(readBands(machine, comparison.values).slice(0, 3).map(band => band.start), [0, window, 2 * window])
  assert.deepEqual(
    [comparison.values[machine.output.notes.lineCount], comparison.values[machine.output.notes.windowOverflow], comparison.values[machine.output.notes.truncated]],
    [3, 2, 0],
  )
  assert.ok(comparison.segments.every(segment => segment.visible === 1))
  // Half as many words as the window holds segments are within the window, and windowOverflow is 0 again.
  const shorter = measure(Array.from({length: window / 2}, () => 'i').join(' '))
  const again = typeAndCompare(machine, shorter)
  assert.deepEqual(again.problems, [])
  assert.deepEqual([again.matchesPretext, again.values[machine.output.notes.windowOverflow], again.values[machine.output.notes.lineCount]], [true, 0, 1])
  // The boundary. A line that holds exactly `window` segments and ends the text didn't wrap early: the cell after
  // the window holds no text. "a-b" is two segments, so the text has an even count. With one more segment, the
  // line wraps at the window.
  const exactly = measure(`${Array.from({length: window / 2 - 1}, () => 'i').join(' ')} a-b`)
  assert.equal(exactly.paragraph.widths.length, window)
  const whole = typeAndCompare(machine, exactly)
  assert.deepEqual(whole.problems, [])
  assert.deepEqual([whole.matchesPretext, whole.values[machine.output.notes.windowOverflow], whole.values[machine.output.notes.lineCount]], [true, 0, 1])
  const oneMore = measure(Array.from({length: window / 2 + 1}, () => 'i').join(' '))
  assert.equal(oneMore.paragraph.widths.length, window + 1)
  const wrapped = typeAndCompare(machine, oneMore)
  assert.deepEqual(wrapped.problems, [])
  assert.deepEqual([wrapped.matchesPretext, wrapped.values[machine.output.notes.windowOverflow], wrapped.values[machine.output.notes.lineCount]], [false, 1, 2])
})

test('a word wider than its slot is laid out whole and reaches past the slot, where pretext would break it between two letters', () => {
  const machine = machineAtStart()
  const text = measure('an incomprehensibilities of it')
  const wideWord = 2
  assert.equal(text.prepared.segments[wideWord], 'incomprehensibilities')
  const wordWidth = text.paragraph.widths[wideWord]!
  assert.ok(wordWidth > 150 && wordWidth < 180, `the word is ${wordWidth} px wide`)
  // At the start, the column beside Photos is 205 px wide, and the word fits it.
  const fitting = typeAndCompare(machine, text)
  assert.deepEqual(fitting.problems, [])
  assert.equal(fitting.matchesPretext, true)
  // Notes at the left edge, and Files above it covering the column except an 85 px slot from 379 to 464.
  const table = Float32Array.from(machine.source)
  const write = (windowIndex: number, geometry: [left: number, top: number, width: number, height: number]) => {
    const [left, top, width, height] = geometry
    table[windowSourceField(windowIndex, windowStateField.left)] = left
    table[windowSourceField(windowIndex, windowStateField.top)] = top
    table[windowSourceField(windowIndex, windowStateField.width)] = width
    table[windowSourceField(windowIndex, windowStateField.height)] = height
  }
  write(notesWindowIndex, [0, 36, 500, 500])
  write(0, [0, 36, 370, 500])
  table[windowSourceField(2, windowStateField.minimized)] = 1
  const order = [2, 1, 0]
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      table[stackSourceField(rank, windowIndex)] = order[rank] === windowIndex ? 1 : 0
    }
  }
  const values = machine.circuit.evaluateTensor(table)
  const narrow = compareWithReferences(machine, values, table, text)
  assert.deepEqual(narrow.problems, [])
  assert.ok(narrow.walked.bands.every(band => band.usable && band.slotWidth === 85))
  assert.equal(narrow.pretext.brokeInsideSegment, true)
  assert.equal(narrow.matchesPretext, false)
  // The word starts its own line at the slot's left edge and ends past the slot's right edge, and the words after it
  // follow on the next lines.
  const word = narrow.segments[wideWord]!
  assert.deepEqual([word.visible, word.x, word.y], [1, 379, notesOptions.padding + notesOptions.lineHeight])
  assert.ok(word.x + wordWidth > 464)
  assert.deepEqual(narrow.segments.map(segment => segment.visible), [1, 1, 1, 1, 1, 1, 1])
  assert.equal(values[machine.output.notes.lineCount], 3)
})

test('an empty text lays out nothing, and a text typed after it is laid out again', () => {
  const machines = {'Notes in front': machineWithNotesInFront(), 'starting arrangement': machineAtStart()}
  for (const [label, machine] of Object.entries(machines)) {
    checkDeclarationsOnEveryEvaluation(machine)
    const empty = typeAndCompare(machine, measure(''))
    assert.deepEqual(empty.problems, [], label)
    assert.equal(machine.source[notesSourceField.arrivedCount], 0)
    const outputs = [...machine.output.notes.segments, ...machine.output.notes.bands, machine.output.notes.lineCount, machine.output.notes.truncated, machine.output.notes.windowOverflow, machine.output.notes.runOverflow]
    assert.ok(outputs.every(wire => Number.isFinite(empty.values[wire])), 'every Notes output is finite')
    assert.deepEqual(
      [machine.output.notes.lineCount, machine.output.notes.truncated, machine.output.notes.windowOverflow, machine.output.notes.runOverflow].map(wire => empty.values[wire]),
      [0, 0, 0, 0],
    )
    // The bands still report their slots, e.g. for a caret in the first usable band.
    assert.equal(readBands(machine, empty.values)[0]!.usable, 1)
    const typed = typeAndCompare(machine, measure('a'))
    assert.deepEqual(typed.problems, [], label)
    assert.deepEqual([typed.segments[0]!.visible, typed.values[machine.output.notes.lineCount]], [1, 1])
  }
})

test('two break-after segments in a row are reported by runOverflow instead of stopping the machine', () => {
  const machine = machineWithNotesInFront()
  machine.notesText({widths: [20, 4, 0, 20], breakAfter: [0, 1, 1, 0]}, pressTime(machine))
  const values = step(machine)
  assert.equal(values[machine.output.notes.runOverflow], 1)
  assert.deepEqual(readSegments(machine, values, 4).map(segment => segment.visible), [1, 1, 1, 1])
  machine.notesText({widths: [20, 4, 20], breakAfter: [0, 1, 0]}, pressTime(machine))
  assert.equal(step(machine)[machine.output.notes.runOverflow], 0)
})

test('cells at the ends of their declared ranges follow the walker\'s rule: widths up to 512 px, zero widths, and runs of break-after segments', () => {
  const machines = {'Notes in front': machineWithNotesInFront(), 'starting arrangement': machineAtStart()}
  const declarationChecks = Object.values(machines).map(checkDeclarationsOnEveryEvaluation)
  const random = createRandom(37)
  const onGrid = (width: number) => Math.round(width * 64) / 64
  const failures: unknown[] = []
  const seen = {widestText: 0, linesPastWindow: 0, truncated: 0, runs: 0, fullCells: 0, emptyCells: 0}
  const trials = 120
  for (let trial = 0; trial < trials; trial++) {
    const kind = trial % 4
    const count = trial < 4 ? notesCapacity : trial < 8 ? 0 : randomInteger(random, 0, notesCapacity)
    const cells: FastParagraph = {widths: [], breakAfter: []}
    for (let segment = 0; segment < count; segment++) {
      if (kind === 0) {
        // Every cell as wide as a cell may be, so the text is as wide as the prefix sums hold exactly, 2^17 px.
        cells.widths.push(maximumSegmentWidth)
        cells.breakAfter.push(segment % 2)
      } else if (kind === 1) {
        // Any width a cell may hold, with runs of segments that break after themselves.
        cells.widths.push(onGrid(random() * maximumSegmentWidth))
        cells.breakAfter.push(random() < 0.4 ? 1 : 0)
      } else if (kind === 2) {
        // Segments of a few px, which pass the walker's window, and zero widths.
        cells.widths.push(random() < 0.2 ? 0 : onGrid(random() * 6))
        cells.breakAfter.push(random() < 0.5 ? 1 : 0)
      } else {
        // Words and spaces of ordinary sizes, and now and then a segment wider than any slot.
        const breakAfter = segment % 2
        cells.widths.push(breakAfter === 1 ? 4.375 : random() < 0.05 ? onGrid(440 + random() * 72) : onGrid(8 + random() * 60))
        cells.breakAfter.push(breakAfter)
      }
    }
    let runs = 0
    for (let segment = 0; segment + 1 < count; segment++) if (cells.breakAfter[segment] === 1 && cells.breakAfter[segment + 1] === 1) runs++
    for (const [label, machine] of Object.entries(machines)) {
      assert.equal(machine.notesText(cells, pressTime(machine)), count)
      const values = step(machine)
      const walked = walkedFlow(cells, arrangementOf(machine.source), notesOptions)
      const problems = flowProblems(machine, values, walked)
      const windowOverflow = values[machine.output.notes.windowOverflow]!
      if (windowOverflow !== walked.windowOverflow) problems.push(`window overflow ${windowOverflow}, expected ${walked.windowOverflow}`)
      const runOverflow = values[machine.output.notes.runOverflow]!
      if (runOverflow !== runs) problems.push(`run overflow ${runOverflow}, expected ${runs}`)
      if (problems.length > 0 && failures.length < 5) failures.push({label, trial, kind, count, problems: problems.slice(0, 4)})
      seen.linesPastWindow += walked.windowOverflow
      seen.truncated += walked.truncated
    }
    seen.widestText = Math.max(seen.widestText, cells.widths.reduce((sum, width) => sum + width, 0))
    seen.runs += runs
    if (count === notesCapacity) seen.fullCells++
    if (count === 0) seen.emptyCells++
  }
  assert.deepEqual(failures, [])
  assert.equal(seen.widestText, notesCapacity * maximumSegmentWidth)
  assert.ok(seen.linesPastWindow > 20 && seen.truncated > 40 && seen.runs > 500, JSON.stringify(seen))
  assert.ok(seen.fullCells >= 4 && seen.emptyCells >= 4, JSON.stringify(seen))
  for (const checks of declarationChecks) assert.equal(checks.evaluations, 2 * trials)
}, 60_000)

test('a text change in the same evaluation as a drag move, and as a maximize release, is laid out around the windows as that evaluation leaves them', () => {
  const machine = machineWithNotesInFront()
  checkDeclarationsOnEveryEvaluation(machine)
  const laidOutWidths = (comparison: Comparison) => comparison.walked.bands.filter(band => band.lineStart !== null).map(band => band.slotWidth)
  // A press on Photos' title bar raises Photos above Notes. Photos is 650,190 560×430, right of the note's column.
  machine.pointerDown(1000, 212, pressTime(machine))
  step(machine)
  // One move drags Photos 100 px left and 48 px down, over the right of the column, and the text changes at the
  // move's timestamp, as when a key and a pointer move arrive together. Both apply in one evaluation.
  const first = measure(typedSentence.slice(0, 150))
  let time = pressTime(machine)
  machine.pointerMove(900, 260, time)
  machine.notesText(first.paragraph, time)
  let values = step(machine)
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [['events', ['pointer move', 'notes text']], ['frame', []]])
  assert.deepEqual([machine.source[windowSourceField(2, windowStateField.left)], machine.source[windowSourceField(2, windowStateField.top)]], [550, 238])
  const dragged = compareWithReferences(machine, values, machine.source, first)
  assert.deepEqual(dragged.problems, [])
  assert.equal(dragged.matchesPretext, true)
  // The new text is laid out around Photos where the move put it: two lines of the whole column above Photos, then
  // lines of the 105 px that Photos leaves at its left.
  const draggedWidths = laidOutWidths(dragged)
  assert.deepEqual(draggedWidths.slice(0, 3), [440, 440, 105])
  assert.ok(draggedWidths.length > 3 && draggedWidths.slice(2).every(width => width === 105), `lines of ${draggedWidths.join(', ')} px`)
  machine.pointerUp(900, 260, pressTime(machine))
  step(machine)
  // A press and a release on Notes' maximize button, at 863,126, which Photos doesn't cover. Another text arrives at
  // the release's timestamp, so one evaluation maximizes Notes, raises it and lays the new text out in the maximized
  // window, where no window is above the note.
  machine.pointerDown(863, 126, pressTime(machine))
  step(machine)
  const second = measure(typedSentence)
  time = pressTime(machine)
  machine.notesText(second.paragraph, time)
  machine.pointerUp(863, 126, time)
  values = step(machine)
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [['events', ['notes text', 'pointer up']], ['frame', []]])
  assert.equal(machine.source[windowSourceField(notesWindowIndex, windowStateField.maximized)], 1)
  assert.equal(values[machine.output.animationActive], 1)
  const maximized = compareWithReferences(machine, values, machine.source, second)
  assert.deepEqual(maximized.problems, [])
  assert.equal(maximized.matchesPretext, true)
  assert.ok(laidOutWidths(maximized).every(width => width === 440))
  assert.ok(maximized.segments.every(segment => segment.visible === 1))
})

// The stored count of presses on the note's content, and the last such press's point in the content box.
function readPress(machine: Machine) {
  const {count, x, y} = machine.cells.notes.press
  return {count: machine.source[count]!, x: machine.source[x]!, y: machine.source[y]!}
}

test('a press on the note\'s content is counted with its point in the content box, and a press elsewhere is not', () => {
  const machine = machineAtStart()
  checkDeclarationsOnEveryEvaluation(machine)
  const press = (x: number, y: number) => {
    const time = pressTime(machine)
    machine.pointerDown(x, y, time)
    machine.pointerUp(x, y, time)
    return step(machine)
  }
  const focusedWindow = (values: Float32Array) =>
    Array.from({length: windowCount}, (_, windowIndex) => values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!]!).indexOf(1)
  assert.deepEqual(readPress(machine), {count: 0, x: 0, y: 0})
  // Notes is 410,104 500×366, so its content box starts at 411,149. Photos (650,190 560×430) is stacked above it:
  // a press on the part of the note that Photos covers goes to Photos.
  assert.equal(focusedWindow(press(700, 300)), 2)
  assert.equal(readPress(machine).count, 0)
  // A press on the part that no window covers is a press on the note, also while Notes isn't the focused window. It
  // raises Notes, and the outputs hold the count and the point in the frame of the press.
  let values = press(520, 300)
  assert.equal(focusedWindow(values), notesWindowIndex)
  assert.deepEqual(readPress(machine), {count: 1, x: 109, y: 151})
  assert.deepEqual([machine.output.notes.press.count, machine.output.notes.press.x, machine.output.notes.press.y].map(wire => values[wire]), [1, 109, 151])
  // Now nothing covers the note, and the press that went to Photos before is a press on the note.
  press(700, 300)
  assert.deepEqual(readPress(machine), {count: 2, x: 289, y: 151})
  // Presses on Notes' title bar, on its resize grip, which lies over the content box's corner, on Files, and on
  // the desktop are no presses on the note.
  press(450, 126)
  press(900, 460)
  assert.equal(focusedWindow(press(100, 300)), 0)
  press(40, 700)
  assert.deepEqual(readPress(machine), {count: 2, x: 289, y: 151})
  // Two presses in one frame count twice, and the last one's point is stored. Files is in front now, and 600,420
  // lies right of it and below it, on the note.
  const time = pressTime(machine)
  machine.pointerDown(600, 420, time)
  machine.pointerUp(600, 420, time)
  machine.pointerDown(610.5, 430.25, time + 2)
  machine.pointerUp(610.5, 430.25, time + 2)
  values = step(machine)
  assert.deepEqual(readPress(machine), {count: 4, x: 199.5, y: 281.25})
  assert.equal(focusedWindow(values), notesWindowIndex)
  // A press is tested against the window's destination: right after the release on Notes' maximize button, while
  // the frame has barely grown, a press at 100,600 is on the maximized content box, which starts at 13,93.
  press(863, 126)
  assert.equal(machine.source[windowSourceField(notesWindowIndex, windowStateField.maximized)], 1)
  values = press(100, 600)
  assert.equal(values[machine.output.animationActive], 1)
  assert.ok(values[machine.output.windows[notesWindowIndex * windowOutputField.size + windowOutputField.width]!]! < 800, 'the frame is still growing')
  assert.deepEqual(readPress(machine), {count: 5, x: 87, y: 507})
})

test('the count of presses on the note starts again at 0 after 255', () => {
  const machine = createWindowManagerMachine()
  // Written before the first step, so the value commits with the mount.
  machine.source[machine.cells.notes.press.count] = 254
  step(machine)
  for (const expected of [255, 0, 1]) {
    const time = pressTime(machine)
    machine.pointerDown(520, 300, time)
    machine.pointerUp(520, 300, time)
    step(machine)
    assert.equal(readPress(machine).count, expected)
  }
})

// The walker over a three-word paragraph whose first two words span exactly 1/64 px
// more than the line: with Safari's epsilon of 1/64 they fit, as pretext's
// `span > limit + epsilon` test says, and with 0.005 they don't. The reference is
// pretext itself at 0.005 (bun's navigator isn't Safari's), and pretext's rule in
// float64 at 1/64.
test('the walker breaks a line at a 1/64 px tie the way pretext does, at either line fit epsilon', () => {
  const prepared = prepareWithSegments('aaaa aaaab aaaa', '1px Tie Test')
  const paragraph: FastParagraph = {widths: prepared.widths.map(width => Math.round(width * 64) / 64), breakAfter: prepared.kinds.map(kind => kind === 'space' ? 1 : 0)}
  assert.deepEqual(paragraph, {widths: [4, 0.5, 4 + 1 / 64, 0.5, 4], breakAfter: [0, 1, 0, 1, 0]})
  const lineWidth = 8.5
  const referenceStarts = (lineFitEpsilon: number) => {
    const starts: number[] = []
    let start = 0
    while (start < paragraph.widths.length) {
      starts.push(start)
      let span = paragraph.widths[start]!
      let end = start + 1
      while (end < paragraph.widths.length) {
        const threshold = span + (paragraph.breakAfter[end] === 1 ? 0 : paragraph.widths[end]!)
        if (threshold > lineWidth + lineFitEpsilon) break
        span += paragraph.widths[end]!
        end++
      }
      // A hanging space ends the line and is skipped at the next start.
      start = end < paragraph.widths.length && paragraph.breakAfter[end] === 1 ? end + 1 : end
    }
    return starts
  }
  const pretextStarts: number[] = []
  let cursor: Cursor = {segmentIndex: 0, graphemeIndex: 0}
  for (let line = layoutNextLineRange(prepared, cursor, lineWidth); line !== null; line = layoutNextLineRange(prepared, cursor, lineWidth)) {
    pretextStarts.push(line.start.segmentIndex)
    cursor = line.end
  }
  assert.deepEqual(pretextStarts, [0, 2, 4])
  assert.deepEqual(referenceStarts(0.005), [0, 2, 4])
  assert.deepEqual(referenceStarts(1 / 64), [0, 4])
  for (const lineFitEpsilon of [0.005, 1 / 64]) {
    const circuit = new Circuit(3 + 2 * paragraph.widths.length)
    const unit = circuit.source(0)
    circuit.assumeRange(unit, 1, 1)
    const startCursor = circuit.source(1)
    circuit.assumeRange(startCursor, 0, paragraph.widths.length)
    // Every cell holds text.
    const arrivedCount = circuit.source(2)
    circuit.assumeRange(arrivedCount, 0, paragraph.widths.length)
    const widthCells = paragraph.widths.map((_, index) => {
      const wire = circuit.source(3 + index)
      circuit.assumeRange(wire, 0, maximumSegmentWidth)
      return wire
    })
    const breakAfterCells = paragraph.widths.map((_, index) => {
      const wire = circuit.source(3 + paragraph.widths.length + index)
      circuit.assumeRange(wire, 0, 1)
      return wire
    })
    const fc = attachFastCircuit(circuit, unit, {startCursor, widthCells, breakAfterCells}, lineFitEpsilon, 1)
    const bands = 3
    const limit = circuit.constant(lineWidth)
    const walk = walkIndexedLines(fc, fastWindow(paragraph, lineWidth, lineFitEpsilon), Array.from({length: bands}, () => limit), Array.from({length: bands}, () => unit), arrivedCount)
    const geometry = segmentGeometry(fc, walk, Array.from({length: bands}, () => circuit.constant(0)), 0, 10)
    const roots = [...walk.starts, walk.lineCount, walk.windowOverflow, ...geometry.x, ...geometry.y, ...geometry.visible]
    const evaluate = circuit.createTensorEvaluator(roots)
    const values = evaluate(Float32Array.from([1, 0, paragraph.widths.length, ...paragraph.widths, ...paragraph.breakAfter]))
    const expectedStarts = referenceStarts(lineFitEpsilon)
    const starts = [...values.subarray(0, bands)]
    assert.deepEqual(starts.slice(0, expectedStarts.length), expectedStarts, `line starts at epsilon ${lineFitEpsilon}`)
    assert.equal(values[bands], expectedStarts.length, 'line count')
    assert.equal(values[bands + 1], 0, 'window overflow')
    const wordX = (segment: number) => values[bands + 2 + segment]!
    const wordY = (segment: number) => values[bands + 2 + paragraph.widths.length + segment]!
    if (lineFitEpsilon === 1 / 64) {
      assert.deepEqual([wordX(0), wordY(0), wordX(2), wordY(2), wordX(4), wordY(4)], [0, 0, 4.5, 0, 0, 10])
    } else {
      assert.deepEqual([wordX(0), wordY(0), wordX(2), wordY(2), wordX(4), wordY(4)], [0, 0, 0, 10, 0, 20])
    }
  }
})

test('at the starting arrangement the paragraph is laid out whole, in 10 lines of 205 px beside Photos', () => {
  const machine = machineAtStart()
  const values = step(machine)
  // Photos covers the right of the column, from above the first line to below the
  // content box, which holds 13 lines. pretext alone breaks the starting text into
  // these 10 lines at 205 px: "Type anything here. The same", "program that runs
  // the", "windows lays out this note.", "Drag Files or Photos over it,", "and every
  // line narrows", "around them. Words move", "straight to their new places", "in
  // one frame, and the lines", "break where pretext would", "break them."
  const words = readWords(machine, values)
  assert.equal(words.filter(word => word.visible === 1).length, 45)
  assert.equal(values[machine.output.notes.lineCount], 10)
  assert.equal(values[machine.output.notes.truncated], 0)
  assert.ok(words.every(word => word.x >= 24 && word.x < 24 + 205))
  assert.deepEqual(new Set(words.map(word => word.y)).size, 10)
  assert.deepEqual(
    readBands(machine, values).map(band => band.usable === 1 ? band.width : 'unusable'),
    Array.from({length: 16}, (_, band) => band < 13 ? 205 : 'unusable'),
  )
})
