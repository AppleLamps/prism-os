// The Notes flow in HandwiredOS, checked against pretext's layoutNextLineRange
// (npm @chenglou/pretext) with a deterministic fake canvas: the circuit and the
// reference read widths from the same prepared text, so the reference's lines and
// word positions are what the circuit must reproduce.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {type LayoutLineRange, type PreparedTextWithSegments, layoutNextLineRange, prepareWithSegments} from '@chenglou/pretext'
import {Circuit} from '../../src/runtime/numeric-ui-core.ts'
import {type FastParagraph, attachFastCircuit, fastWindow, segmentGeometry, walkGatheredLines} from '../../src/handwiredos/notes-walker.ts'
import {
  type NotesOptions,
  defaultLineFitEpsilon,
  defaultNotesParagraph,
  lineFitEpsilonFor,
  measureNotesParagraph,
  notesOptionsFor,
  notesWords,
} from '../../src/handwiredos/notes-paragraph.ts'
import {
  bandOutputField,
  createWindowManagerMachine,
  createWordNodes,
  notesWindowIndex,
  projectNotesWords,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
  wordOutputField,
} from '../../src/handwiredos/window-manager.ts'

// A deterministic canvas: letters vary between 28/64 and 40/64 of the font size,
// spaces are 20/64 and punctuation 22/64, so every width lies on the 1/64 px grid
// at 14 px. notes-paragraph.ts's default widths were baked with this rule. The
// "Tie Test" font measures in whole and 1/64 px for the line fit tie test below.
function fakeTextWidth(text: string, font: string): number {
  const fontSize = Number.parseFloat(font.match(/(\d+(?:\.\d+)?)\s*px/)?.[1] ?? '16')
  if (font.includes('Tie Test')) {
    let width = 0
    for (const character of text) width += character === ' ' ? 0.5 : character === 'b' ? 1 / 64 : 1
    return width
  }
  let sixtyFourths = 0
  for (const character of text) {
    if (character === ' ') sixtyFourths += 20
    else if (/[.,!?;:%)\]}'"”’»›…—-]/u.test(character)) sixtyFourths += 22
    else sixtyFourths += 28 + (character.codePointAt(0)! % 13)
  }
  return sixtyFourths * fontSize / 64
}

class FakeContext {
  font = ''
  measureText(text: string) {
    return {width: fakeTextWidth(text, this.font)}
  }
}
// pretext creates its measuring context at its first measurement, so this runs
// before any prepare call in this file.
Reflect.set(globalThis, 'OffscreenCanvas', class {
  getContext() {
    return new FakeContext()
  }
})

const testFont = '14px Test Serif'
const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16
// pretext under bun: the navigator isn't Safari's, so its epsilon is 0.005.
const epsilon = defaultLineFitEpsilon
const measured = measureNotesParagraph(testFont)
const notesOptions = notesOptionsFor(defaultNotesParagraph, epsilon)
// The segment index of each word, e.g. word 1 is segment 2, after the first space.
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

type Word = {x: number, y: number, visible: number}

function readWords(machine: Machine, values: Float32Array): Word[] {
  return notesWords.map((_, word) => {
    const start = word * wordOutputField.size
    const read = (field: number) => values[machine.output.notes.words[start + field]!]!
    return {x: read(wordOutputField.x), y: read(wordOutputField.y), visible: read(wordOutputField.visible)}
  })
}

function readBands(machine: Machine, values: Float32Array) {
  return Array.from({length: notesOptions.bands}, (_, band) => {
    const start = band * bandOutputField.size
    const read = (field: number) => values[machine.output.notes.bands[start + field]!]!
    return {usable: read(bandOutputField.usable), left: read(bandOutputField.left), width: read(bandOutputField.width), start: read(bandOutputField.start)}
  })
}

type Rectangle = {left: number, top: number, width: number, height: number}

// Whether a laid-out word's box, as wide as the word and one line tall, overlaps a
// rectangle. Both are in the content box's coordinates.
function wordOverlaps(word: Word, wordIndex: number, rectangle: Rectangle) {
  const wordWidth = measured.paragraph.widths[wordSegments[wordIndex]!]!
  return word.visible === 1
    && word.x < rectangle.left + rectangle.width && word.x + wordWidth > rectangle.left
    && word.y < rectangle.top + rectangle.height && word.y + notesOptions.lineHeight > rectangle.top
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

// The reference: dynamic-layout's column carving for several rectangles, with
// pretext's layoutNextLineRange per band. Plain float64. A band is unusable when
// no slot is at least minimumSlotWidth wide, or when its bottom lies below the
// content box.
type Cursor = {segmentIndex: number, graphemeIndex: number}
type Interval = {left: number, right: number}
type ReferenceFlow = {
  bands: {usable: boolean, left: number, slotWidth: number, line: LayoutLineRange | null, cutByHeight: boolean}[]
  segments: {visible: boolean, x: number, y: number}[]
}

function referenceNotesFlow(prepared: PreparedTextWithSegments, paragraph: FastParagraph, arrangement: Arrangement, options: NotesOptions): ReferenceFlow {
  const bands: ReferenceFlow['bands'] = []
  const segments = paragraph.widths.map(() => ({visible: false, x: 0, y: 0}))
  let cursor: Cursor = {segmentIndex: 0, graphemeIndex: 0}
  for (let band = 0; band < options.bands; band++) {
    const bandTop = options.padding + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    const blocked: Interval[] = arrangement.obstacles
      .filter(obstacle => obstacle.active && !(bandBottom <= obstacle.top - options.verticalPadding || bandTop >= obstacle.top + obstacle.height + options.verticalPadding))
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
    const cutByHeight = slots.length > 0 && bandBottom > arrangement.contentHeight
    if (slots.length === 0 || cutByHeight) {
      bands.push({usable: false, left: 0, slotWidth: 0, line: null, cutByHeight})
      continue
    }
    let slot = slots[0]!
    for (const candidate of slots.slice(1)) {
      const bestWidth = slot.right - slot.left
      const candidateWidth = candidate.right - candidate.left
      if (candidateWidth > bestWidth || (candidateWidth === bestWidth && candidate.left > slot.left)) slot = candidate
    }
    const slotWidth = slot.right - slot.left
    const line = layoutNextLineRange(prepared, cursor, slotWidth)
    bands.push({usable: true, left: slot.left, slotWidth, line, cutByHeight: false})
    if (line === null) continue
    let x = slot.left
    for (let segment = line.start.segmentIndex; segment < line.end.segmentIndex; segment++) {
      segments[segment] = {visible: true, x, y: bandTop}
      x += paragraph.widths[segment]!
    }
    cursor = line.end
  }
  return {bands, segments}
}

// Evaluates the machine's program on a table and compares the Notes outputs with
// the reference for that table's arrangement: each band's slot and line start,
// and each word's position and visibility.
function compareWithReference(machine: Machine, table: Float32Array) {
  const values = machine.circuit.evaluateTensor(table)
  const arrangement = arrangementOf(table)
  const reference = referenceNotesFlow(measured.prepared, measured.paragraph, arrangement, notesOptions)
  const problems: string[] = []
  readBands(machine, values).forEach((band, index) => {
    const expected = reference.bands[index]!
    if (band.usable !== Number(expected.usable)) problems.push(`band ${index} usable ${band.usable}, expected ${Number(expected.usable)}`)
    else if (expected.usable && (band.left !== expected.left || band.width !== expected.slotWidth)) problems.push(`band ${index} slot ${band.left},${band.width}, expected ${expected.left},${expected.slotWidth}`)
    else if (expected.usable) {
      const start = expected.line === null ? measured.paragraph.widths.length : expected.line.start.segmentIndex
      if (band.start !== start) problems.push(`band ${index} starts at ${band.start}, expected ${start}`)
    }
  })
  const words = readWords(machine, values)
  const windowsAbove = arrangement.obstacles.filter(obstacle => obstacle.active)
  // Laid-out words on a line that is level with part of a window stacked above
  // Notes, i.e. the words that the overlap check could catch.
  let wordsBesideWindowsAbove = 0
  words.forEach((word, wordIndex) => {
    const segment = wordSegments[wordIndex]!
    const expected = reference.segments[segment]!
    if (word.visible !== (expected.visible ? 1 : 0)) problems.push(`segment ${segment} visible ${word.visible}, expected ${Number(expected.visible)}`)
    else if (expected.visible && (word.x !== Math.fround(expected.x) || word.y !== expected.y)) problems.push(`segment ${segment} at ${word.x},${word.y}, expected ${expected.x},${expected.y}`)
    if (word.visible === 1 && windowsAbove.some(window => word.y < window.top + window.height && word.y + notesOptions.lineHeight > window.top)) wordsBesideWindowsAbove++
    for (const window of windowsAbove) {
      if (wordOverlaps(word, wordIndex, window)) problems.push(`segment ${segment} at ${word.x},${word.y} overlaps the window above Notes at ${window.left},${window.top}`)
    }
  })
  const truncated = values[machine.output.notes.truncated]!
  const expectedTruncated = Number(!reference.segments.at(-1)!.visible)
  if (truncated !== expectedTruncated) problems.push(`truncated ${truncated}, expected ${expectedTruncated}`)
  return {problems, reference, arrangement, values, words, wordsBesideWindowsAbove}
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
  const order = Array.from({length: windowCount}, (_, index) => index).sort(() => random() - 0.5)
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
  assert.deepEqual([notesOptions.window, notesOptions.runLimit, notesOptions.minimumSlotWidth], [26, 1, 80])
  // The fake widths lie on the 1/64 px grid, so the reference and the circuit see the same numbers.
  assert.ok(measured.prepared.widths.every(width => Number.isInteger(width * 64)))
  assert.equal(lineFitEpsilonFor(navigator), epsilon)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15', vendor: 'Apple Computer, Inc.'}), 1 / 64)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36', vendor: 'Google Inc.'}), 0.005)
  assert.equal(lineFitEpsilonFor({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0', vendor: ''}), 0.005)
})

test('the machine refuses a paragraph with other segments than the default one', () => {
  assert.throws(
    () => createWindowManagerMachine({notes: {paragraph: {widths: [10, 4, 10], breakAfter: [0, 1, 0]}, epsilon}}),
    /the Notes paragraph must have the same segments as the default one/,
  )
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
  for (let trial = 0; trial < 40; trial++) {
    const table = Float32Array.from(machine.source)
    writeArrangement(table, random)
    const {problems, reference, arrangement, wordsBesideWindowsAbove} = compareWithReference(machine, table)
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
  assert.ok(truncatedArrangements > 0 && truncatedArrangements < 40, `${truncatedArrangements} arrangements truncated`)
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
  assert.equal(machine.source[windowSourceField(3, windowStateField.minimized)], 1)
  assert.equal(values[machine.output.animationActive], 1)
  const during = readWords(machine, values)
  assert.notDeepEqual(during, before)
  // In the frame of the press, the text already fills Photos' area, while Photos is
  // still drawn there at nearly full size on its way to the dock: the flow reads
  // which windows are visible after the event, not the drawn frames.
  const photosOutput = (field: number) => values[machine.output.windows[3 * windowOutputField.size + field]!]!
  assert.equal(photosOutput(windowOutputField.opacity), 1)
  assert.ok(photosOutput(windowOutputField.scale) > 0.9, `Photos drawn at scale ${photosOutput(windowOutputField.scale)}`)
  // The obstacles are Files, System Monitor and Photos, in window order.
  const photosArea = arrangementOf(machine.source).obstacles[2]!
  assert.equal(photosArea.active, false)
  assert.ok(during.some((word, wordIndex) => wordOverlaps(word, wordIndex, photosArea)), 'some word is laid out in Photos\' area')
  // The words don't move again while Photos flies to the dock.
  const settled = settle(machine)
  assert.deepEqual(readWords(machine, settled), during)
  assert.deepEqual(compareWithReference(machine, machine.source).problems, [])
  // System Monitor is still above Notes, but it starts below the fifth line, and
  // with Photos gone the paragraph fits in 5 lines.
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
  // Raise Notes above System Monitor and Photos, then drag Files (520×340) to
  // 380,60: it covers the whole column of the default Notes window (content box
  // 498×320) down to band 10, the paragraph continues in bands 11 and 12, and
  // bands 13 to 15 end below the 320 px content box.
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
  const ungated = referenceNotesFlow(measured.prepared, measured.paragraph, {...arrangement, contentHeight: Infinity}, notesOptions)
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
  table[windowSourceField(3, windowStateField.minimized)] = 1
  const order = [2, 3, 1, 0]
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      table[stackSourceField(rank, windowIndex)] = order[rank] === windowIndex ? 1 : 0
    }
  }
  const {problems, values, words, reference} = compareWithReference(machine, table)
  assert.deepEqual(problems, [])
  const notesWires = [
    ...machine.output.notes.words,
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
    const circuit = new Circuit(2 + 2 * paragraph.widths.length)
    const unit = circuit.source(0)
    circuit.assumeRange(unit, 1, 1)
    const startCursor = circuit.source(1)
    circuit.assumeRange(startCursor, 0, paragraph.widths.length)
    const widthCells = paragraph.widths.map((_, index) => {
      const wire = circuit.source(2 + index)
      circuit.assumeRange(wire, 0, 2048)
      return wire
    })
    const breakAfterCells = paragraph.widths.map((_, index) => {
      const wire = circuit.source(2 + paragraph.widths.length + index)
      circuit.assumeRange(wire, 0, 1)
      return wire
    })
    const fc = attachFastCircuit(circuit, unit, {startCursor, widthCells, breakAfterCells}, lineFitEpsilon, 1)
    const bands = 3
    const limit = circuit.constant(lineWidth)
    const walk = walkGatheredLines(fc, fastWindow(paragraph, lineWidth, lineFitEpsilon), Array.from({length: bands}, () => limit), Array.from({length: bands}, () => unit))
    const geometry = segmentGeometry(fc, walk, Array.from({length: bands}, () => circuit.constant(0)), 0, 10)
    const roots = [...walk.starts, walk.lineCount, walk.windowOverflow, ...geometry.x, ...geometry.y, ...geometry.visible]
    const evaluate = circuit.createTensorEvaluator(roots)
    const values = evaluate(Float32Array.from([1, 0, ...paragraph.widths, ...paragraph.breakAfter]))
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

test('one span per word is created once and positioned from the outputs', () => {
  const machine = createWindowManagerMachine()
  const values = step(machine)
  const created: {className: string, textContent: string, style: Record<string, string>}[] = []
  const document = {
    createElement() {
      const node = {className: '', textContent: '', style: {} as Record<string, string>}
      created.push(node)
      return node as unknown as HTMLElement
    },
  }
  const appended: unknown[] = []
  const content = {
    appendChild(node: Node) {
      appended.push(node)
      return node
    },
  }
  const nodes = createWordNodes(document, content as unknown as HTMLElement, notesWords)
  assert.equal(created.length, notesWords.length)
  assert.equal(appended.length, notesWords.length)
  assert.deepEqual(created.map(node => node.textContent), notesWords)
  assert.ok(created.every(node => node.className === 'notes-word'))
  projectNotesWords(nodes, values, machine.output.notes.words)
  const words = readWords(machine, values)
  created.forEach((node, index) => {
    assert.equal(node.style['transform'], `translate3d(${words[index]!.x}px,${words[index]!.y}px,0)`)
    assert.equal(node.style['opacity'], `${words[index]!.visible}`)
  })
  // At the default arrangement, Photos covers the right of the column and System
  // Monitor the lower left, so the paragraph gets 7 lines of 205 px, and the last 10
  // words aren't laid out.
  assert.equal(words.filter(word => word.visible === 1).length, 35)
  assert.equal(values[machine.output.notes.lineCount], 7)
  assert.equal(values[machine.output.notes.truncated], 1)
  assert.ok(words.filter(word => word.visible === 1).every(word => word.x >= 24 && word.x < 24 + 205))
})
