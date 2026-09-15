// Stage 4: the Notes paragraph flowing around the other windows, checked against
// pretext's layoutNextLineRange with the deterministic fake canvas.
import {expect, test} from 'bun:test'
import {createBoxCheck, windowAndPhotoBoxes, wordBoxes} from './box-check.ts'
import {lineFitEpsilon, loadPretext} from './fake-canvas.ts'
import {generateQueueTrace} from './queue-traces.ts'
import {fastParagraph} from './fast-walker.ts'
import {type IndirectOSMachine, createIndirectOSMachine, originalOptions} from './indirect-os.ts'
import {createRandom, randomInteger} from './input-kit.ts'
import {type NotesArrangement, referenceNotesFlow} from './notes-reference.ts'
import {notesOptionsFor, notesText, testFont} from './paragraph.ts'
import {read} from './wires.ts'

const pretext = await loadPretext()
const prepared = pretext.prepareWithSegments(notesText, testFont)
const paragraph = fastParagraph(prepared)
const notesOptions = notesOptionsFor(paragraph, lineFitEpsilon)
export const notesMachineOptions = {...originalOptions, springs: 'bank' as const, photosViewport: 'stepped-springs' as const, input: {kind: 'queue' as const, capacity: 8, maximumDowns: 2}, notes: notesOptions}

export function settle(machine: IndirectOSMachine, viewport: {width: number, height: number}, clock: {time: number}) {
  for (let frame = 0; frame < 20; frame++) {
    const {values} = machine.stepFrame(viewport.width, viewport.height, clock.time += 1000, [])
    if (values[machine.output.animationActive] === 0) return values
  }
  throw new Error('the springs did not settle')
}

// The obstacles as the reference sees them: settled projected windows, drawn and stacked above Notes.
export function arrangementOf(machine: IndirectOSMachine, values: Float32Array): NotesArrangement {
  const windows = read(values, machine.output.windows)
  const titleHeight = machine.source[machine.cells.layout.titleHeight]!
  const notes = windows[1]!
  const rankOf = (index: number) => machine.cells.stack.findIndex(row => machine.source[row[index]!] === 1)
  const contentLeft = notes.translateX + 1
  const contentTop = notes.translateY + titleHeight + 1
  return {
    columnLeft: notesOptions.padding,
    columnWidth: Math.min(notesOptions.maximumColumnWidth, Math.max(0, notes.width - 2 - 2 * notesOptions.padding)),
    obstacles: [0, 2, 3].map(index => {
      const window = windows[index]!
      const width = window.width * window.scale
      const height = window.height * window.scale
      return {
        left: window.translateX + (window.width - width) / 2 - contentLeft,
        top: window.translateY + (window.height - height) / 2 - contentTop,
        width,
        height,
        active: window.opacity === 1 && rankOf(index) > rankOf(1),
      }
    }),
  }
}

export function compareWithPretext(machine: IndirectOSMachine, values: Float32Array) {
  const arrangement = arrangementOf(machine, values)
  const reference = referenceNotesFlow(pretext.layoutNextLineRange as never, prepared, paragraph, arrangement, notesOptions)
  const notes = read(values, machine.output.notes!)
  const problems: string[] = []
  if (notes.windowOverflow !== 0) problems.push('window overflow')
  if (notes.runOverflow !== 0) problems.push('run overflow')
  // Each band's slot, and the start and painted width of its line.
  read(values, machine.debug.notes!.bands).forEach((band, index) => {
    const expected = reference.bands[index]!
    if (band.usable !== Number(expected.usable)) problems.push(`band ${index} usable`)
    else if (expected.usable && (band.left !== expected.left || band.width !== expected.slotWidth)) problems.push(`band ${index} slot ${band.left},${band.width}, expected ${expected.left},${expected.slotWidth}`)
    else if (expected.usable) {
      const start = expected.line === null ? paragraph.widths.length : expected.line.start.segmentIndex
      const lineWidth = expected.line === null ? 0 : Math.fround(expected.line.width)
      if (band.start !== start || band.lineWidth !== lineWidth) problems.push(`band ${index} line ${band.start},${band.lineWidth}, expected ${start},${lineWidth}`)
    }
  })
  // Settled words sit exactly where the reference puts them.
  let wordIndex = 0
  paragraph.breakAfter.forEach((breakAfter, segment) => {
    if (breakAfter === 1) return
    const expected = reference.segments[segment]!
    const word = notes.words[wordIndex++]!
    if (word.visible !== (expected.visible ? 1 : 0)) problems.push(`segment ${segment} visible`)
    else if (expected.visible && (word.x !== Math.fround(expected.x) || word.y !== expected.y)) problems.push(`segment ${segment} at ${word.x},${word.y}, expected ${expected.x},${expected.y}`)
  })
  return {problems, reference, arrangement}
}

function writeArrangement(machine: IndirectOSMachine, random: () => number, viewport: {width: number, height: number}) {
  const {source, cells} = machine
  cells.windows.forEach((window, index) => {
    const width = randomInteger(random, 280, 700)
    const height = randomInteger(random, 190, 520)
    source[window.width] = width
    source[window.height] = height
    source[window.left] = randomInteger(random, 0, viewport.width - width)
    source[window.top] = randomInteger(random, 36, 724 - height)
    source[window.minimized] = index !== 1 && random() < 0.15 ? 1 : 0
  })
  const order = [0, 1, 2, 3].sort(() => random() - 0.5)
  cells.stack.forEach((row, rank) => row.forEach((wire, index) => {
    source[wire] = order[rank] === index ? 1 : 0
  }))
}

test('settled flows around random window arrangements match pretext line for line and word for word', () => {
  const machine = createIndirectOSMachine(notesMachineOptions, {debugOutputs: true})
  const viewport = {width: 1280, height: 800}
  const clock = {time: 0}
  const random = createRandom(11)
  let checkedWords = 0
  let blockedBands = 0
  let bandsWithTwoSlots = 0
  const failures: unknown[] = []
  for (let trial = 0; trial < 12; trial++) {
    writeArrangement(machine, random, viewport)
    const values = settle(machine, viewport, clock)
    const {problems, reference, arrangement} = compareWithPretext(machine, values)
    checkedWords += reference.segments.filter(segment => segment.visible).length
    blockedBands += reference.bands.filter(band => !band.usable || band.slotWidth < arrangement.columnWidth).length
    for (let band = 0; band < notesOptions.bands; band++) {
      const top = notesOptions.padding + band * notesOptions.lineHeight
      const blocking = arrangement.obstacles.filter(obstacle => obstacle.active && !(top + notesOptions.lineHeight <= obstacle.top - 4 || top >= obstacle.top + obstacle.height + 4))
      if (blocking.length >= 2) bandsWithTwoSlots++
    }
    if (problems.length > 0) failures.push({trial, problems: problems.slice(0, 4)})
  }
  expect(failures).toEqual([])
  expect(checkedWords).toBeGreaterThan(200)
  expect(blockedBands).toBeGreaterThan(20)
  expect(bandsWithTwoSlots).toBeGreaterThan(0)
})

test('every window, thumbnail and word box of the whole program matches float64 doctrine springs along a queue trace', () => {
  const machine = createIndirectOSMachine(notesMachineOptions, {debugOutputs: true})
  const check = createBoxCheck(machine, [...windowAndPhotoBoxes(machine), ...wordBoxes(machine)])
  const {frames} = generateQueueTrace({seed: 9, frames: 300, capacity: 8, maximumDowns: 2})
  let time = 0
  for (const frame of frames) machine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
  expect(check.evaluationsWithSteps).toBeGreaterThan(150)
  expect(check.boxesChecked).toBe(check.evaluations * (16 + paragraph.breakAfter.filter(bit => bit === 0).length))
  expect(check.clockMismatches).toBe(0)
  expect(check.firstSettleMismatch).toBeNull()
  expect(check.maxPositionError).toBeLessThan(1e-3)
})

test('dragging Files over Notes reflows the paragraph, and the settled words match pretext', () => {
  const machine = createIndirectOSMachine(notesMachineOptions, {debugOutputs: true})
  const viewport = {width: 1280, height: 800}
  const clock = {time: 0}
  settle(machine, viewport, clock)
  const before = read(machine.values, machine.output.notes!).words.map(word => word.y)
  // Files' title bar at 100,70; drag it right by 400 and down by 100, over the Notes window.
  machine.stepFrame(1280, 800, clock.time += 16, [{kind: 'down', x: 100, y: 70}, {kind: 'move', x: 300, y: 120}])
  machine.stepFrame(1280, 800, clock.time += 16, [{kind: 'move', x: 500, y: 170}, {kind: 'up', x: 500, y: 170}])
  const values = settle(machine, viewport, clock)
  const {problems, arrangement} = compareWithPretext(machine, values)
  expect(problems).toEqual([])
  expect(arrangement.obstacles[0]!.active).toBe(true)
  const after = read(values, machine.output.notes!).words.map(word => word.y)
  expect(after).not.toEqual(before)
})
